import {
    ActionCreatorWithoutPayload,
    AnyAction,
    createAsyncThunk,
    ThunkDispatch,
} from '@reduxjs/toolkit'
import { API_ROOT, streamSource } from '../../utils'
import { getViewId } from '../codemirror/codemirrorSelectors'
import {
    FullCodeMirrorState,
    getCodeMirrorView,
} from '../codemirror/codemirrorSlice'
import { throttle } from 'lodash'
import { acceptDiff, rejectDiff, setDiff } from '../extensions/diff'
import { getActiveFileId, getActiveTabId } from '../window/paneUtils'
import { FullState } from '../window/state'
import {
    activateDiffFromEditor,
    appendResponse,
    changeDraftMsgType,
    changeMsgType,
    doSetChatState,
    doSetMessages,
    dummySubmitCommandBar,
    // chatSlice,
    endFinishResponse,
    getLastBotMessage,
    interruptGeneration,
    manufacturedConversation,
    newResponse,
    openCommandBar,
    PromptCancelledError,
    rejectMessage,
    resumeGeneration,
    setChatOpen,
    setCurrentDraftMessage,
    setGenerating,
    startNewMessage,
    tokenLimitInterrupt,
    updateLastUserMessageMsgType,
} from './chatSlice'
import { Text } from '@codemirror/state'
import { addTransaction, openError, openFile } from '../globalSlice'
import { findFileIdFromPath, getPathForFileId } from '../window/fileUtils'
import {
    getPrecedingLines,
    getProcedingLines,
    getSelectedPos,
    getSelectedText,
} from '../../components/editor'
import { getLastBotMessageById, getLastUserMessage } from './chatSelectors'
import { editBoundaryEffect, insertCursorEffect } from '../extensions/hackDiff'
import posthog from 'posthog-js'
import { getCopilotSnippets } from './promptUtils'
import { CustomTransaction } from '../../components/codemirrorHooks/dispatch'
import { getFixLSPBlobForServerWithSideEffects } from '../linter/fixLSPExtension'
import {
    activeLintField,
    getDiagnostics,
    lintState,
    setActiveLint,
} from '../linter/lint'

function getMatchingLines(doc: Text, ...lines: string[]): number[][] {
    // Iterate through the lines in the document and find matching line numbers
    // Initialize an empty array to store matching line numbers
    let matchingLineNumbers = Array(lines.length).fill([])

    // Iterate through the lines in the document
    for (let i = 0; i < doc.lines; i++) {
        // Get the line text at the current index
        const lineText = doc.line(i + 1).text

        for (let j = 0; j < lines.length; j++) {
            // If the line text matches the line text at the current index, add the line number to the array
            //
            if (lineText.trimEnd() === lines[j]) {
                matchingLineNumbers[j].push(i + 1)
            }
        }
    }

    return matchingLineNumbers
}

const thunkFactory = (
    actionCreator: ActionCreatorWithoutPayload,
    name: string
) =>
    createAsyncThunk(
        `chat/${name}`,
        async (payload: null, { getState, dispatch }) => {
            dispatch(actionCreator())
            // If message type is chat_edit, then we want to change the message type to chat
            if (
                (getState() as FullState).chatState.userMessages.at(-1)
                    ?.msgType == 'chat_edit'
            ) {
                dispatch(diffResponse('chat'))
            } else {
                dispatch(streamResponse({}))
            }
        }
    )

export async function getPayload({
    getState,
    dispatch,
    conversationId,
    forContinue = false,
    forDiagnostics = false,
    diagnosticLineNumber,
}: {
    getState: () => FullState
    dispatch: ThunkDispatch<unknown, unknown, AnyAction>
    conversationId: string
    forContinue?: boolean
    forDiagnostics?: boolean
    diagnosticLineNumber?: number
}) {
    dispatch(setGenerating(true))

    const state = getState() as FullState
    let chatState = state.chatState
    let fileCache = state.global.fileCache
    const currentTab = getActiveTabId(state.global)!

    const userMessages = chatState.userMessages.filter(
        (um) => um.conversationId == conversationId
    )

    const lastUserMessage = userMessages[userMessages.length - 1]

    if (!(forContinue || forDiagnostics)) {
        posthog.capture('Submitted Prompt', {
            type: chatState.msgType,
            prompt: lastUserMessage.message,
        })
        posthog.capture('Submitted ' + chatState.msgType, {
            prompt: lastUserMessage.message,
        })

        // TODO - make this work when currentTab is None
        if (currentTab != null) {
            // TODO - have this directly dispatch the transaction
            dispatch(
                addTransaction({
                    tabId: currentTab,
                    transactionFunction: {
                        // Starts the undo ig
                        type: 'bar',
                        blob: {
                            message: lastUserMessage.message,
                            activateBundle: {
                                currentFile: lastUserMessage.currentFile,
                                precedingCode: lastUserMessage.precedingCode,
                                procedingCode: lastUserMessage.procedingCode,
                                currentSelection:
                                    lastUserMessage.currentSelection,
                                selection: lastUserMessage.selection,
                                pos: chatState.pos,
                            },
                        },
                    },
                })
            )
        }
    } else {
        posthog.capture('Submitted non-prompt transaction', {
            type: chatState.msgType,
        })
    }

    // add in prompts to the last user message
    const fileId = lastUserMessage.currentFile
        ? findFileIdFromPath(state.global, lastUserMessage.currentFile)
        : null
    const currentFileContents = fileId ? fileCache[fileId!]?.contents : null

    let copilotCodeBlocks =
        fileId == null ? [] : await getCopilotSnippets(state, fileId)

    let customCodeBlocks = [
        ...lastUserMessage.otherCodeBlocks.map((block) => {
            return {
                text: block.text,
                path: getPathForFileId(state.global, block.fileId)!,
            }
        }),
    ]

    // Capture all `CODE_HERE` with regex from the last message
    let capturedSymbols = lastUserMessage.message
        .match(/`(\w+\.*)+`/g)
        ?.map((symbol) => symbol.replace(/`/g, ''))
    // Convert to a set
    let codeSymbols = new Set<string>()
    if (capturedSymbols) {
        capturedSymbols.forEach((symbol) => {
            codeSymbols.add(symbol)
        })
    }
    // Now set filter out the lastUserMessage.codeSymbols to only be the ones that are in the message

    let codeBlockIdentifiers = [
        ...lastUserMessage.codeSymbols
            .filter((symbol) => codeSymbols.has(symbol.name))
            .map((symbol) => ({
                fileName: symbol.fileName,
                blockName: symbol.name,
                type: symbol.type,
            })),
    ]
    // Split the `precedingCode` into chunks of 20 line blocks called `precedingCodeBlocks`
    const blockSize = 20

    let precedingCodeBlocks = []
    if (lastUserMessage.precedingCode) {
        let precedingCodeLines = lastUserMessage.precedingCode.split('\n')
        for (let i = 0; i < precedingCodeLines.length; i += blockSize) {
            let block = precedingCodeLines.slice(i, i + blockSize)
            precedingCodeBlocks.push(block.join('\n'))
        }
    }

    // Split the `procedingCodeBlocks` into chunks of 20 line blocks called `procedingCodeBlocks`
    let procedingCodeBlocks = []
    if (lastUserMessage.procedingCode) {
        let procedingCodeLines = lastUserMessage.procedingCode.split('\n')
        for (let i = 0; i < procedingCodeLines.length; i += blockSize) {
            let block = procedingCodeLines.slice(i, i + blockSize)
            procedingCodeBlocks.push(block.join('\n'))
        }
    }

    const rootPath = state.global.rootPath

    // Get the viewId and the editorView
    // Really hacky - need to change at some point
    const viewId = getViewId(currentTab)(
        getState() as unknown as FullCodeMirrorState
    )
    let editorView
    if (viewId) {
        editorView = getCodeMirrorView(viewId)
    } else {
        editorView = null
    }

    // hack
    dispatch(updateLastUserMessageMsgType(null))

    const userRequest = {
        // Core request
        message: lastUserMessage.message,
        // Context of the current file
        currentRootPath: rootPath,
        currentFileName: lastUserMessage.currentFile,
        currentFileContents,
        // Context surrounding the cursor position
        precedingCode: precedingCodeBlocks,
        currentSelection: lastUserMessage.currentSelection,
        suffixCode: procedingCodeBlocks,
        // Get Copilot values
        copilotCodeBlocks,
        // Get user defined values
        customCodeBlocks,
        codeBlockIdentifiers,
        msgType: chatState.msgType,
        // Messy, but needed for the single lsp stuff to work
        maxOrigLine: forContinue
            ? getLastBotMessage(chatState, conversationId)!.maxOrigLine
            : forDiagnostics
            ? lastUserMessage.maxOrigLine
            : null,
        diagnostics:
            forDiagnostics && editorView
                ? getFixLSPBlobForServerWithSideEffects(
                      editorView,
                      diagnosticLineNumber
                  )?.diagnostics
                : null,
    }

    const data = {
        userRequest,
        userMessages: [
            ...chatState.userMessages
                .filter(
                    (um) => um.conversationId == lastUserMessage.conversationId
                )
                .slice(0, -1),
        ],

        botMessages: [
            ...chatState.botMessages.filter(
                (bm) => bm.conversationId == lastUserMessage.conversationId
            ),
        ],
        //useFour: state.settingsState.settings.useFour === 'enabled',
        contextType: state.settingsState.settings.contextType,

        rootPath: state.global.rootPath,
    }

    // document.cookie = `repo_path=${state.global.rootPath}`
    return data
}

export const continueGeneration = createAsyncThunk(
    'chat/continueGeneration',
    async (
        {
            conversationId,
            setFinished = false,
        }: { conversationId: string; setFinished: boolean },
        { getState, dispatch }
    ) => {
        try {
            const getFullState = () => getState() as FullState

            // forcontinue is set to true here
            const data = await getPayload({
                getState: getFullState,
                dispatch,
                conversationId,
                forContinue: true,
            })
            const state = getState() as FullState

            const chatState = state.chatState
            const currentTab = getActiveTabId(state.global)!

            const numUserMessages = chatState.userMessages.length
            function checkSend() {
                if (
                    numUserMessages !=
                    (<FullState>getState()).chatState.userMessages.length
                ) {
                    dispatch(interruptGeneration(null))
                    throw new PromptCancelledError()
                }
            }
            // Hit the diffs endpoint
            const server = `${API_ROOT}/continue/`

            const response = await fetch(server, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Cookie: `repo_path=${state.global.rootPath}`,
                },
                //credentials: 'include',
                body: JSON.stringify(data),
            })

            dispatch(resumeGeneration(conversationId))

            // There must exist this view
            const editorViewId = getViewId(currentTab)(
                getState() as FullCodeMirrorState
            )!
            const editorView = getCodeMirrorView(editorViewId)!

            const isGenerating = () =>
                (<FullState>getState()).chatState.generating
            const isInterrupted = () =>
                (<FullState>getState()).chatState.botMessages.at(-1)
                    ?.interrupted

            let generator = streamSource(response)

            const getNextToken = async () => {
                let rawResult = await generator.next()
                if (rawResult.done) return null
                return rawResult.value
            }
            let buffer = ''
            let bigBuffer = chatState.botMessages
                .filter((bm) => bm.conversationId == conversationId)
                .at(-1)!.message

            const pos = chatState.pos == undefined ? 0 : chatState.pos
            let currentPos = pos

            let toBreak = false
            let finalMessage = ''

            const throttledAppendResponse = throttle(
                (text: string, token: string) =>
                    dispatch(appendResponse({ text, token })),
                100
            )

            while (!toBreak) {
                let token = await getNextToken()
                // When there are no more tokens, or we are interrupted, stop the generation
                if (token == null) break
                if (!isGenerating() || isInterrupted()) break
                if ((buffer + token).match(/.*<\|\w*?\|>.*/)) {
                    if (
                        (buffer + token).includes('<|END_message|>') ||
                        (buffer + token).includes('<|END_interrupt|>')
                    ) {
                        finalMessage = buffer + token

                        buffer += token
                        buffer = buffer.slice(0, buffer.indexOf('<|'))
                        toBreak = true
                    } else {
                        buffer += token
                    }
                } else if ((buffer + token).length > 20) {
                    buffer += token
                    // Then we ignore the other stuff
                } else if ((buffer + token).includes('<|')) {
                    buffer += token
                    continue
                } else if (token.includes('<')) {
                    buffer += token
                    continue
                } else {
                    buffer += token
                }
                bigBuffer += buffer
                currentPos += buffer.length
                checkSend()
                throttledAppendResponse(bigBuffer, token)
                buffer = ''
            }
            dispatch(appendResponse({ text: bigBuffer, token: '' }))
            buffer = finalMessage
            while (true) {
                if (buffer.includes(`<|END_interrupt|>`)) {
                    buffer = buffer.replace(`<|END_interrupt|>`, '')
                    // Interrupt the generation here when we run out of tokens

                    dispatch(tokenLimitInterrupt())
                    //dispatch(cs.setChatOpen(false))
                    break
                } else if (buffer.includes(`<|END_message|>`)) {
                    buffer = buffer.replace(`<|END_message|>`, '')
                    break
                }
                let token = await getNextToken()
                buffer += token

                if (!isGenerating() || isInterrupted()) break
            }

            checkSend()

            const lastBotMessage = getLastBotMessage(
                (getState() as FullState).chatState
            )!
            if (
                !setFinished &&
                lastBotMessage.type == 'edit' &&
                lastBotMessage.interrupted &&
                lastBotMessage.hitTokenLimit
            ) {
                // Do nothing
            } else {
                dispatch(finishResponse())
            }
        } catch (e) {
            dispatch(setGenerating(false))
            if (!(e instanceof PromptCancelledError)) {
                dispatch(openError(null))
                dispatch(interruptGeneration(null))
            }
        }
    }
)

export const finishResponse = createAsyncThunk(
    'chat/finishResponse',
    async (arg, { dispatch, getState }) => {
        const chatState = (getState() as FullState).chatState
        // connector.setStore('userMessages', chatState.userMessages)
        // connector.setStore('botMessages', chatState.botMessages)
        connector.setStore('chatState', chatState)
        dispatch(endFinishResponse())
    }
)

export const initializeChatState = createAsyncThunk(
    'chat/getResponse',
    async (payload: null, { getState, dispatch }) => {
        // const userMessages = await connector.getStore('userMessages');
        // const botMessages = await connector.getStore('botMessages');
        const chatState = await connector.getStore('chatState')
        // dispatch(doSetMessages({ userMessages, botMessages }));
        dispatch(doSetChatState(chatState))
    }
)

export const streamResponse = createAsyncThunk(
    'chat/getResponse',
    async (
        { useDiagnostics = false }: { useDiagnostics?: boolean | number },
        { getState, dispatch }
    ) => {
        try {
            const getFullState = () => getState() as FullState
            const conversationId =
                getFullState().chatState.currentConversationId
            let lastBotMessage = getLastBotMessage(
                getFullState().chatState,
                conversationId
            )

            useDiagnostics = lastBotMessage?.useDiagnostics ?? useDiagnostics

            const data = await getPayload({
                getState: getFullState,
                dispatch,
                conversationId,
                forDiagnostics: !(useDiagnostics === false),
                diagnosticLineNumber:
                    typeof useDiagnostics === 'number'
                        ? useDiagnostics
                        : undefined,
            })

            const state = getState() as FullState
            const chatState = state.chatState
            const currentTab = getActiveTabId(state.global)!

            const numUserMessages = chatState.userMessages.length
            function checkSend() {
                if (
                    numUserMessages !=
                    (<FullState>getState()).chatState.userMessages.length
                ) {
                    dispatch(interruptGeneration(null))
                    throw new PromptCancelledError()
                }
            }
            const server = `${API_ROOT}/conversation`

            const response = await fetch(server, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Cookie: `repo_path=${state.global.rootPath}`,
                },
                //credentials: 'include',
                body: JSON.stringify(data),
            })

            let generator = streamSource(response)

            const isGenerating = () =>
                (<FullState>getState()).chatState.generating
            const isInterrupted = () =>
                (<FullState>getState()).chatState.botMessages.at(-1)
                    ?.interrupted

            const getNextToken = async () => {
                let rawResult = await generator.next()
                if (rawResult.done) return null
                return rawResult.value
            }

            const getNextWord = async (
                condition: (buff: string) => boolean,
                startBuffer = '',
                capture: (buff: string) => string = (buff) => buff
            ) => {
                while (!condition(startBuffer)) {
                    let nextToken = await getNextToken()
                    if (nextToken == null) return null
                    startBuffer += nextToken
                }
                return capture(startBuffer)
            }

            const getVariable = async (
                startToken: string,
                variableName: string
            ) => {
                let buffer = await getNextWord(
                    (buff) => buff.includes('|>'),
                    startToken
                )
                while (true) {
                    let token = await getNextToken()
                    if (token == null) break
                    if (token.includes('<|')) {
                        buffer = token
                        break
                    }
                    buffer += token
                    if (buffer!.includes(``)) {
                        break
                    }
                }
                while (true) {
                    let token = await getNextToken()
                    buffer += token!
                    if (buffer!.includes(`<|END_${variableName}|>`)) {
                        break
                    }
                }

                // parse out the value between the tags
                let value = buffer!.match(
                    /<\|BEGIN_\w+\|>([\s\S]*)<\|END_\w+\|>/
                )![1]!
                return { value, buffer }
            }

            /**
             * Sends the body of a message by identifying the token the message starts with and adding tokens until finding the end.
             * @param startToken Token the message started with
             * @param typeStr Type of message (e.g. 'continue', 'new')
             * @returns void - this function is async and returns no value
             */

            const throttledAppendResponse = throttle(
                (text: string, token: string) =>
                    dispatch(appendResponse({ text, token })),
                100
            )

            const sendBody = async (startToken: string, typeStr: string) => {
                await getNextWord((buff) => buff.includes('|>'), startToken)
                let buffer = ''
                let bigBuffer = ''

                const pos = chatState.pos == undefined ? 0 : chatState.pos
                let currentPos = pos

                let isFirstToken = true

                let toBreak = false
                let finalMessage = ''
                while (!toBreak) {
                    let token = await getNextToken()
                    // When there are no more tokens, or we are interrupted, stop the generation
                    // Wait for 100 ms

                    //
                    if (token == null) break
                    if (!isGenerating() || isInterrupted()) break
                    if ((buffer + token).match(/.*<\|\w*?\|>.*/)) {
                        if (
                            (buffer + token).includes('<|END_message|>') ||
                            (buffer + token).includes('<|END_interrupt|>')
                        ) {
                            finalMessage = buffer + token

                            buffer += token
                            buffer = buffer.slice(0, buffer.indexOf('<|'))
                            toBreak = true
                        } else {
                            buffer += token
                        }
                    } else if ((buffer + token).length > 20) {
                        buffer += token
                        // Then we ignore the other stuff
                    } else if ((buffer + token).includes('<|')) {
                        buffer += token
                        continue
                    } else if (token.includes('<')) {
                        buffer += token
                        continue
                    } else {
                        buffer += token
                    }

                    if (typeStr == 'continue') {
                        checkSend()
                        if (isFirstToken) {
                            dispatch(
                                addTransaction({
                                    tabId: currentTab,
                                    transactionFunction: {
                                        type: 'insertStartLine',
                                        from: currentPos,
                                        to: currentPos,
                                        text: buffer,
                                        scroll: 'intoView',
                                    },
                                })
                            )
                            isFirstToken = false
                        } else {
                            dispatch(
                                addTransaction({
                                    tabId: currentTab,
                                    transactionFunction: {
                                        type: 'insert',
                                        // from: currentPos,
                                        // to: currentPos,
                                        text: buffer,
                                        scroll: 'intoView',
                                    },
                                })
                            )
                        }
                    }
                    bigBuffer += buffer
                    currentPos += buffer.length
                    checkSend()
                    // This might cause a bug with things like generate but not sure
                    throttledAppendResponse(bigBuffer, token)
                    // dispatch(appendResponse({ text: bigBuffer, token: token }))
                    buffer = ''
                }
                dispatch(appendResponse({ text: bigBuffer, token: '' }))
                buffer = finalMessage
                while (true) {
                    if (buffer.includes(`<|END_interrupt|>`)) {
                        buffer = buffer.replace(`<|END_interrupt|>`, '')
                        // Interrupt the generation here when we run out of tokens

                        dispatch(tokenLimitInterrupt())
                        //dispatch(cs.setChatOpen(false))
                        break
                    } else if (buffer.includes(`<|END_message|>`)) {
                        buffer = buffer.replace(`<|END_message|>`, '')
                        break
                    }
                    let token = await getNextToken()
                    buffer += token

                    if (!isGenerating() || isInterrupted()) break
                }
            }

            const processResponse = async () => {
                let { value, buffer } = await getVariable('', 'type')
                checkSend()
                dispatch(newResponse({ type: value.trim(), useDiagnostics }))
                await sendBody(''!, value.trim())
                if (value.trim() == 'location') {
                    const state = <FullState>getState()
                    let locString =
                        state.chatState.botMessages[
                            state.chatState.botMessages.length - 1
                        ].message
                    let locJson: {
                        filePath: string
                        startLine: number
                        endLine: number
                    } = JSON.parse(locString)
                    checkSend()
                    await dispatch(
                        openFile({
                            filePath: locJson.filePath,
                            selectionRegions: [
                                {
                                    start: {
                                        line: locJson.startLine,
                                        character: 0,
                                    },
                                    end: {
                                        line: locJson.endLine,
                                        character: 0,
                                    },
                                },
                            ],
                        })
                    )
                } else if (value.trim() == 'gotoEdit') {
                    let generationString =
                        state.chatState.botMessages[
                            state.chatState.botMessages.length - 1
                        ].message
                    let generationJson: {
                        filePath: string
                        startLine: number
                        endLine: number
                        text: string
                    }[] = JSON.parse(generationString)

                    const relevantFilePath = generationJson[0].filePath
                    //
                    if (
                        !generationJson.every(
                            (value) => value.filePath == relevantFilePath
                        )
                    ) {
                        console.error(
                            'Got multi-file edits which are not yet supported',
                            generationJson
                        )
                        throw new Error(
                            `Filepaths do not all match - ${relevantFilePath}`
                        )
                    }

                    // Todo investigate this for causing an error with line numbers changing as diffs are added
                    checkSend()
                    const thunkResult = await dispatch(
                        openFile({
                            filePath: relevantFilePath,
                        })
                    )
                    if (!openFile.fulfilled.match(thunkResult)) {
                        return null
                    } else if (thunkResult.payload == null) {
                        return null
                    }

                    const tabId = thunkResult.payload
                    const transactionFunction: CustomTransaction[] =
                        generationJson.map((change) => ({
                            type: 'insert',
                            from: {
                                line: change.startLine,
                                col: 0,
                            },
                            to: {
                                line: change.endLine,
                                col: 0,
                            },
                            text: change.text,
                        }))

                    checkSend()
                    dispatch(
                        addTransaction({
                            tabId,
                            transactionFunction,
                        })
                    )
                }
            }

            await processResponse()
            checkSend()

            lastBotMessage = getLastBotMessage(
                (getState() as FullState).chatState
            )!
            if (
                lastBotMessage.type == 'edit' &&
                lastBotMessage.interrupted &&
                lastBotMessage.hitTokenLimit
            ) {
                await dispatch(continueUntilEnd(lastBotMessage.conversationId))
            }
            dispatch(finishResponse())
        } catch (e) {
            //
            //
            dispatch(setGenerating(false))
            if (!(e instanceof PromptCancelledError)) {
                dispatch(openError(null))
                dispatch(interruptGeneration(null))
            }
        }
    }
)

export const continueUntilEnd = createAsyncThunk(
    'chat/continueUntilEnd',
    async (conversationId: string, { getState, dispatch }) => {
        try {
            await dispatch(
                continueGeneration({ conversationId, setFinished: false })
            )
            while (
                getLastBotMessageById(conversationId)(getState() as FullState)
                    ?.hitTokenLimit &&
                getLastBotMessageById(conversationId)(getState() as FullState)
                    ?.interrupted
            ) {
                await dispatch(
                    continueGeneration({ conversationId, setFinished: false })
                )
            }
            dispatch(finishResponse())
        } catch (e) {
            dispatch(setGenerating(false))
            if (!(e instanceof PromptCancelledError)) {
                dispatch(openError(null))
                dispatch(interruptGeneration(null))
                dispatch(finishResponse())
            }
        }
    }
)

export const diffResponse = createAsyncThunk(
    'chat/diffResponse',
    async (type: 'lsp' | 'chat' | null, { getState, dispatch }) => {
        try {
            // Making this chat_edit message type
            type = type || 'chat'

            const getFullState = () => getState() as FullState
            let lastBotMessage = getLastBotMessage(getFullState().chatState)
            let useDiagnostics = lastBotMessage?.useDiagnostics || type == 'lsp'

            let data = await getPayload({
                getState: getFullState,
                dispatch,
                conversationId: getFullState().chatState.currentConversationId,
                forDiagnostics: !(useDiagnostics === false),
                diagnosticLineNumber:
                    typeof useDiagnostics === 'number'
                        ? useDiagnostics
                        : undefined,
            })

            const state = getState() as FullState

            const chatState = state.chatState
            const currentTab = getActiveTabId(state.global)!

            const numUserMessages = chatState.userMessages.length
            function checkSend() {
                if (
                    numUserMessages !=
                    (<FullState>getState()).chatState.userMessages.length
                ) {
                    dispatch(interruptGeneration(null))
                    throw new PromptCancelledError()
                }
            }
            // Hit the diffs endpoint

            const server = `${API_ROOT}/diffs/`

            // Exclamation means this can only be invoked if the value is not null
            const viewId = getViewId(currentTab)(state)!
            const view = getCodeMirrorView(viewId)!

            // Override data to set selected_code as the whole doc
            data.userRequest.currentSelection = view.state.doc.toString()

            // If the cursor is in a current pos, set the active line to the top of that
            data.userRequest.maxOrigLine = view.state.doc.lineAt(
                view.state.selection.main.from
            ).number

            // Set the message to dummy data
            // data.userRequest.message =
            //     'create a new Modal component, importing from headlessui'

            const response = await fetch(server, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // Cookie: `repo_path=${state.global.rootPath}`,
                },
                //credentials: 'include',
                body: JSON.stringify(data),
            })

            // There must exist this view
            const editorViewId = getViewId(currentTab)(
                getState() as FullCodeMirrorState
            )!
            const editorView = getCodeMirrorView(editorViewId)!
            dispatch(setGenerating(true))

            const isGenerating = () =>
                (<FullState>getState()).chatState.generating
            const isInterrupted = () =>
                (<FullState>getState()).chatState.botMessages.at(-1)
                    ?.interrupted

            // Dispatching a new response from main
            dispatch(
                newResponse({
                    type: type == 'chat' ? 'chat_edit' : 'lsp_edit',
                    useDiagnostics,
                })
            )

            const origState = editorView.state
            let generator = streamSource(response)
            let usedChunks = []
            for await (let chunk of generator) {
                if (!isGenerating() || isInterrupted()) {
                }
                // checkSend()
                // chunk will n

                let typedChunk = chunk as null | {
                    diff_number: number
                    start_line: number
                    start_line_text: string
                    end_line: number
                    end_line_text: string
                    new_code: string
                    finished: boolean
                    last: boolean
                }

                if (typedChunk == null || typedChunk.last) {
                    // we're probably done. Just in case, dont break
                } else {
                    // We're gonna run set diff
                    // first, we're gonna need to get the text between start_line and end_line

                    // If the chunk has finished, add the current typedChunk to the start of usedChunks

                    // Build up the updatedText using all usedChunks
                    let updatedText = origState.doc

                    //
                    let tmpChunks = [typedChunk, ...usedChunks]
                    tmpChunks.sort((a, b) => a.start_line - b.start_line)
                    for (const chunk of [typedChunk, ...usedChunks]) {
                        const [startLines, endLines] = getMatchingLines(
                            updatedText,
                            chunk.start_line_text,
                            chunk.end_line_text
                        )
                        let start, end
                        if (startLines.length == 1) {
                            start = updatedText.line(startLines[0]).from
                        } else {
                            start = origState.doc.line(chunk.start_line).from
                        }

                        if (endLines.length == 1) {
                            end = updatedText.line(endLines[0]).to
                        } else {
                            end = origState.doc.line(chunk.end_line - 1).to
                        }

                        let newText = Text.of(chunk.new_code.split('\n'))
                        updatedText = updatedText.replace(start, end, newText)
                    }

                    if (typedChunk.finished) {
                        usedChunks.unshift(typedChunk)
                    }
                    // Set the diff with the updatedText

                    setDiff({
                        origLine: 1,
                        origEndLine: origState.doc.lines,
                        origText: origState.doc,
                        newText: updatedText,
                        diffId: getFullState().chatState.currentConversationId,
                        setCurrentActiveLine: false,
                    })(view)
                }
            }

            let updatedText = origState.doc

            for (const chunk of usedChunks) {
                const [startLines, endLines] = getMatchingLines(
                    updatedText,
                    chunk.start_line_text,
                    chunk.end_line_text
                )
                let start, end
                if (startLines.length == 1) {
                    start = updatedText.line(startLines[0]).from
                } else {
                    start = origState.doc.line(chunk.start_line).from
                }

                if (endLines.length == 1) {
                    end = updatedText.line(endLines[0]).to
                } else {
                    end = origState.doc.line(chunk.end_line - 1).to
                }

                let newText = Text.of(chunk.new_code.split('\n'))
                updatedText = updatedText.replace(start, end, newText)
            }
            dispatch(
                appendResponse({ text: updatedText.toString(), token: '' })
            )
            dispatch(finishResponse())
            //debugger
            setDiff({
                origLine: 1,
                origEndLine: origState.doc.lines,
                origText: origState.doc,
                newText: updatedText,
                diffId: getFullState().chatState.currentConversationId,
                setCurrentActiveLine: false,
                isFinalDiff: true,
                isFinished: true,
            })(view)
            //debugger

            checkSend()
            //debugger
        } catch (e) {
            console.error(e)
            dispatch(setGenerating(false))
            if (!(e instanceof PromptCancelledError)) {
                dispatch(openError(null))
                dispatch(interruptGeneration(null))
                dispatch(finishResponse())
            }
        }
    }
)
export const pressAICommand = createAsyncThunk(
    'chat/pressAICommand',
    (
        // TODO - use this instead of keypress
        // aiFunction: 'allLSPs' | 'codegen' | 'chat' | 'accept' | 'interrupt',
        keypress:
            | 'Shift-Enter'
            | 'k'
            | 'l'
            | 'Enter'
            | 'Backspace'
            | 'singleLSP',
        { getState, dispatch }
    ) => {
        // If currently responding to a chat, make this a chat_edit response
        const chatState = (getState() as FullState).chatState
        const globState = (getState() as FullState).global

        const tabId = getActiveTabId(globState)
        const fileId = getActiveFileId(globState)

        const viewId = getViewId(tabId)(getState() as FullCodeMirrorState)
        const editorView = viewId && getCodeMirrorView(viewId)

        // Okay, this will be the main logic in general here
        const lastBotMessage = getLastBotMessage(
            chatState,
            chatState.currentConversationId
        )
        if (chatState.generating && keypress != 'Backspace') {
            // Do nothing!
            return
        }
        switch (keypress) {
            case 'Enter':
                // Need to be in diff state or diff accept state
                if (
                    chatState.msgType === 'edit' ||
                    chatState.msgType == 'chat_edit'
                ) {
                    if (lastBotMessage?.finished && editorView) {
                        acceptDiff(lastBotMessage.conversationId)(editorView)
                    }
                }
                return
            case 'Backspace':
                if (
                    // chatState.msgType === 'edit' ||
                    // chatState.msgType == 'chat_edit'
                    // For we now dont do this here bc of weird cmd+backspace behavior in editor
                    false
                ) {
                    // if (lastBotMessage && editorView) {
                    //     if (lastBotMessage?.finished) {
                    //         // In the case where done loading, we reject the message
                    //         dispatch(
                    //             rejectMessage(lastBotMessage.conversationId)
                    //         )
                    //         rejectDiff(lastBotMessage.conversationId)(
                    //             editorView
                    //         )
                    //     } else {
                    //
                    //         dispatch(
                    //             interruptGeneration(
                    //                 lastBotMessage.conversationId
                    //             )
                    //         )
                    //     }
                    // }
                } else if (chatState.msgType != 'edit') {
                    if (lastBotMessage && chatState.generating) {
                        dispatch(
                            interruptGeneration(lastBotMessage.conversationId)
                        )
                    }
                }
                return
            case 'l':
                // If the chat state is currently open, then we close it
                if (chatState.chatIsOpen) {
                    // Close it
                    dispatch(setChatOpen(false))
                } else {
                    dispatch(changeMsgType('freeform'))
                    if (!editorView) {
                        dispatch(
                            activateDiffFromEditor({
                                currentFile: null,
                                precedingCode: null,
                                procedingCode: null,
                                currentSelection: null,
                                pos: 0,
                                selection: null,
                            })
                        )
                        dispatch(openCommandBar())
                    } else {
                        const selection = editorView.state.selection.main

                        // TODO - need to remove antipattern of dispatching multiple reducers at once.
                        // This should be handled by a single dispatch call
                        dispatch(openCommandBar())
                        dispatch(
                            activateDiffFromEditor({
                                currentFile: getPathForFileId(
                                    globState,
                                    fileId!
                                )!,
                                precedingCode: getPrecedingLines(
                                    editorView,
                                    20
                                )!,
                                procedingCode: getProcedingLines(editorView)!,
                                currentSelection: getSelectedText(editorView)!,
                                pos: selection.from,
                                selection: {
                                    from: selection.from,
                                    to: selection.to,
                                },
                            })
                        )
                    }
                }
                return
            case 'k':
                if (chatState.chatIsOpen && lastBotMessage?.finished) {
                    if (editorView) {
                        // Check if editorView in focus
                        if (!editorView.hasFocus) {
                            // When there is an editorView not in focus, we dispatch this
                            dispatch(changeMsgType('chat_edit'))
                            dispatch(changeDraftMsgType('chat_edit'))
                            return
                        }
                    }
                    // Close the chat if the chat is open then
                    dispatch(setChatOpen(false))
                }

                if (editorView) {
                    const selPos = getSelectedPos(editorView)
                    const selection = editorView.state.selection.main
                    editorView.dispatch({
                        effects: editBoundaryEffect.of({
                            start: selPos.startLinePos,
                            end: selPos.endLinePos,
                        }),
                    })
                    const cursorPos = selection.from

                    //const preceedingPos = getPrecedingLinesPos(view, 20);
                    editorView.dispatch({
                        effects: insertCursorEffect.of({
                            //pos: preceedingPos.endLinePos+1,
                            pos: cursorPos,
                        }),
                    })

                    if (selection.from != selection.to) {
                        // Always done before command bar - though we need to clean this up
                        dispatch(changeMsgType('edit'))
                        dispatch(openCommandBar())
                    } else {
                        dispatch(changeMsgType('generate'))
                        dispatch(openCommandBar())
                    }
                    dispatch(
                        activateDiffFromEditor({
                            currentFile: getPathForFileId(globState, fileId!)!,
                            precedingCode: getPrecedingLines(editorView, 20)!,
                            procedingCode: getProcedingLines(editorView),
                            currentSelection: getSelectedText(editorView)!,
                            pos: selection.from,
                            selection: {
                                from: selection.from,
                                to: selection.to,
                            },
                        })
                    )
                }
                return
            case 'Shift-Enter':
                if (editorView) {
                    dispatch(
                        manufacturedConversation({
                            userMessage: 'Help me fix this errors',
                            messageType: 'freeform',
                            currentFile: getPathForFileId(globState, fileId!)!,
                            // Get the entire editor
                            currentSelection: editorView.state.doc.toString(),
                        })
                    )
                    dispatch(streamResponse({ useDiagnostics: true }))
                }
                return
            case 'singleLSP':
                if (editorView) {
                    const currentErrorField =
                        editorView.state.field(activeLintField)
                    editorView.dispatch({ effects: setActiveLint.of(null) })

                    let relevantLine
                    if (currentErrorField) {
                        relevantLine = currentErrorField.line
                    } else {
                        let diagnostics = getDiagnostics(
                            editorView.state.field(lintState),
                            editorView.state
                        )
                        const seriousDiagnostics = diagnostics.filter(
                            (d) => d.severity == 'error'
                        )
                        const currentPos = editorView.state.selection.main.from

                        for (let diagnostic of seriousDiagnostics) {
                            if (
                                currentPos <= diagnostic.to &&
                                currentPos >= diagnostic.from
                            ) {
                                relevantLine = editorView.state.doc.lineAt(
                                    diagnostic.from
                                ).number
                                break
                            }
                        }
                    }

                    if (relevantLine != null) {
                        dispatch(
                            manufacturedConversation({
                                userMessage: 'Help me fix this error',
                                messageType: 'freeform',
                                currentFile: getPathForFileId(
                                    globState,
                                    fileId!
                                )!,
                                // Get the entire editor
                                currentSelection:
                                    editorView.state.doc.toString(),
                                userMaxOrigLine: relevantLine,
                            })
                        )
                        dispatch(
                            streamResponse({ useDiagnostics: relevantLine })
                        )
                    }
                }
                return
            default:
                return
        }
    }
)

export const submitCommandBar = thunkFactory(
    dummySubmitCommandBar,
    'submitCommandBar'
)
