import {
    findFileIdFromPath,
    getPathForFileId,
    getPathForFolderId,
} from '../window/fileUtils'
import { FullState } from '../window/state'
import { getContentsIfNeeded } from '../window/fileUtils'
import { current } from '@reduxjs/toolkit'
import { joinAdvanced } from '../../utils'
import { badWords } from './badWords'

export function splitIntoWords(e: string) {
    return e
        .split(/[^a-zA-Z0-9]/)
        .filter((e) => e.length > 0)
        .filter((e) => !badWords.has(e))
}

// jaccard distance
// TODO check

function compareWords(a: string[], b: string[]) {
    let intersection = 0
    let union = 0
    let aSet = new Set(a)
    let bSet = new Set(b)
    let cSet = new Set()
    for (let word of aSet) {
        if (bSet.has(word)) {
            intersection++
            cSet.add(word)
        }
        union++
    }
    for (let word of bSet) {
        if (!aSet.has(word)) union++
    }
    const fairUnion = Math.min(union, aSet.size, bSet.size)
    return intersection / fairUnion
}

function getExtension(fileName: string): string {
    return fileName.split('.').pop()!
}

function filterFilesByExtension(
    state: FullState,
    fileIds: number[],
    extension: string
) {
    return fileIds.filter((fileId) => {
        return state.global.files[fileId].name.endsWith(extension)
    })
}

async function loadContentsOfFileIds(
    state: FullState,
    fileIds: number[]
): Promise<FileContents> {
    // keyed by number
    const contentsArr: { [key: number]: string } = {}
    for (let fileId of fileIds) {
        contentsArr[fileId] = await getContentsIfNeeded(state.global, fileId)
    }
    return contentsArr
}

function filterFilesByLength(state: FullState, fileContents: FileContents) {
    return Object.keys(fileContents)
        .filter((fileId) => {
            const len = fileContents[parseInt(fileId)].split('\n').length
            return len > 0 && len < 1000
        })
        .map((fileId) => parseInt(fileId))
}

function getFileIdsNotInForbidden(
    state: FullState,
    forbiddenFolders: string[]
) {
    // start at root folder (id 1) and then recursively find files, make sure to not go into forbidden folders
    let fileIds: number[] = []
    let foldersToVisit: number[] = [1]
    while (foldersToVisit.length > 0) {
        let folderId = foldersToVisit.pop()!
        let folder = state.global.folders[folderId]
        for (let fileId of folder.fileIds) {
            fileIds.push(fileId)
        }
        for (let subFolderId of folder.folderIds) {
            const subFolderName = state.global.folders[subFolderId].name
            if (
                !forbiddenFolders.includes(subFolderName) &&
                subFolderName[0] != '.'
            ) {
                foldersToVisit.push(subFolderId)
            }
        }
    }
    return fileIds
}

// typedef for a set of strings keyed by number
interface FileContents {
    [key: number]: string
}
async function getMostRecentFileIds(state: FullState, fileId: number) {
    const extension = getExtension(state.global.files[fileId].name)
    const startingFileIds = getFileIdsNotInForbidden(state, ['node_modules'])
    const matchedExtensions = filterFilesByExtension(
        state,
        startingFileIds,
        extension
    )
    const contents = await loadContentsOfFileIds(state, matchedExtensions)
    // filter the file ids that are too long
    let candidateFileIds = filterFilesByLength(state, contents).filter(
        (fid) => {
            return fid != fileId
        }
    )
    candidateFileIds = candidateFileIds.filter((fid) => {
        return state.global.files[fid].latestAccessTime != null
    })
    candidateFileIds = candidateFileIds
        .sort((a, b) => {
            const first = state.global.files[b].latestAccessTime || 0
            const second = state.global.files[a].latestAccessTime || 0
            return first - second
        })
        .slice(0, 20)

    // return the contents
    return candidateFileIds.reduce((acc, fileId) => {
        acc[fileId] = contents[fileId]
        return acc
    }, {} as FileContents)
}

interface Range {
    startLine: number
    endLine: number
    fileId: number
}

interface PromptSnippet {
    text: string
    path: string
}

export async function getCopilotSnippets(
    state: FullState,
    fileId: number,
    slidingWindow: number = 50,
    maxSnippets: number = 5,
    thresholdSimilarity: number = 0.2
): Promise<PromptSnippet[]> {
    let words = splitIntoWords(state.global.fileCache[fileId].contents)
    let snippets: { score: number; fileId: number; text: string }[] = []

    // get the 20 most recent fileids
    let recentFileContents = await getMostRecentFileIds(state, fileId)
    let maxSim = 0
    let maxSnippet = null
    for (let fidStr of Object.keys(recentFileContents)) {
        let fileId = parseInt(fidStr)
        const path = getPathForFileId(state.global, fileId)
        let contents = recentFileContents[fileId]
        let lines = contents.split('\n')

        for (let i = 0; i < Math.max(1, lines.length - slidingWindow); i++) {
            let window = lines.slice(i, i + slidingWindow).join('\n')
            let windowWords = splitIntoWords(window)
            let similarity = compareWords(words, windowWords)
            if (similarity > thresholdSimilarity) {
                snippets[fileId] = {
                    score: similarity,
                    fileId: fileId,
                    text: window,
                }
            }
            if (similarity > maxSim) {
                maxSim = similarity
                maxSnippet = window
            }
        }
    }

    let sortedSnippets = Object.values(snippets)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSnippets)
        .map((e) => {
            return {
                text: e.text,
                path: getPathForFileId(state.global, e.fileId),
            }
        })
    return sortedSnippets
}

export async function getIntellisenseSymbols(
    state: FullState,
    fileId: number
): Promise<string[]> {
    // TODO loop through current file and get all top level function statements
    // Find all imported file paths
    // Try to locate them on disk
    // for each find their exported function statementsA
    // pass back a string array

    const fileContents = await getContentsIfNeeded(state.global, fileId)
    const lines = fileContents.split('\n')
    const symbols: string[] = []
    const currentFolderPath = getPathForFolderId(
        state.global,
        state.global.files[fileId].parentFolderId
    )
    for (let line of lines) {
        // find function name in any line that begins with function
        const match = line.match(/^\s*(export )?function ([a-zA-Z0-9_]+)/)
        if (match) {
            symbols.push(match[2])
        }
    }

    // find the paths of all local imported files
    const importRegex = /import .* from ['"](.*)['"]/g
    const importMatches = fileContents.matchAll(importRegex)
    const moduleRegex = /import \* as ([a-zA-Z0-9_]+) from/
    for (let match of importMatches) {
        const importPath = match[1]
        const moduleMatch = match[0].match(moduleRegex)
        const moduleName =
            moduleMatch && moduleMatch.length > 1 ? moduleMatch[1] : null
        // maerge current folder path with import path
        const fullPath = joinAdvanced(currentFolderPath, importPath)
        let foundFile = false
        for (let ext of ['ts', 'tsx', 'js', 'jsx']) {
            const fileId = findFileIdFromPath(
                state.global,
                fullPath + '.' + ext
            )
            if (fileId) {
                foundFile = true
                const fileContents = await getContentsIfNeeded(
                    state.global,
                    fileId
                )
                const lines = fileContents.split('\n')
                for (let line of lines) {
                    // match exported function statem
                    let match = line.match(
                        /^\s*export (type )?(enum )?(interface )?(const )?(async )?(function )?([a-zA-Z0-9_]+)/
                    )
                    if (match) {
                        // regex to get import * as ___ from
                        let found = match[7]
                        if (moduleName) {
                            found = moduleName + '.' + found
                        }
                        symbols.push(found)
                    }
                }
                break
            }
        }
        if (!foundFile) {
        }
    }
    return symbols
}

export async function getAllExportedFunctionSymbols(
    state: FullState,
    fileId: number
): Promise<string[]> {
    const fileContents = await getContentsIfNeeded(state.global, fileId)
    const lines = fileContents.split('\n')
    const symbols: string[] = []
    for (let line of lines) {
        // find function name in any line that begins with function
        const match = line.match(/^\s*(export )?function ([a-zA-Z0-9_]+)/)
        if (match) {
            symbols.push(match[2])
        }
    }

    return symbols
}
