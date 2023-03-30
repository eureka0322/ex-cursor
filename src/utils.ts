export const API_ROOT = 'https://aicursor.com'

export async function* streamSource(response: Response): AsyncGenerator<any> {
    // Check if the response is an event-stream
    if (
        response.headers.get('content-type') ==
        'text/event-stream; charset=utf-8'
    ) {
        // Create a reader to read the response body as a stream
        // const reader = response.body.getReader();
        // Fix the above error: `response.body is possibly null`
        const reader = response.body!.getReader()
        // Create a decoder to decode the stream as UTF-8 text
        const decoder = new TextDecoder('utf-8')

        // Loop until the stream is done
        while (true) {
            const { value, done } = await reader.read()
            if (done) {
                break
            }

            const rawValue = decoder.decode(value)
            const lines = rawValue.split('\n')

            for (let line of lines) {
                if (line.startsWith('data: ')) {
                    const jsonString = line.slice(6)
                    if (jsonString == '[DONE]') {
                        return
                    }
                    yield JSON.parse(jsonString)
                }
            }
        }
    } else {
        // Raise exception
        throw new Error('Response is not an event-stream')
    }
}
// Another streaming function similar to streamSource, but slightly different
export async function* anotherStreamSource(
    response: Response
): AsyncGenerator<any> {
    // Check if the response is an event-stream
    if (
        response.headers.get('content-type') ==
        'text/event-stream; charset=utf-8'
    ) {
        // Create a reader to read the response body as a stream
        const reader = response.body!.getReader()
        // Create a decoder to decode the stream as UTF-8 text
        const decoder = new TextDecoder('utf-8')

        // Loop until the stream is done
        while (true) {
            const { value, done } = await reader.read()
            if (done) {
                break
            }

            const rawValue = decoder.decode(value)
            const lines = rawValue.split('\n')

            for (let line of lines) {
                if (line.startsWith('data: ')) {
                    const jsonString = line.slice(6)
                    if (jsonString == '[DONE]') {
                        return
                    }
                    // Slightly different: wrap the parsed JSON object in an additional object
                    yield { data: JSON.parse(jsonString) }
                }
            }
        }
    } else {
        // Raise exception
        throw new Error('Response is not an event-stream')
    }
}

export function getPlatformInfo(): {
    PLATFORM_DELIMITER: string
    PLATFORM_META_KEY: string
    PLATFORM_CM_KEY: string
    IS_WINDOWS: boolean
} {
    let PLATFORM_DELIMITER: string
    let PLATFORM_META_KEY: string
    let PLATFORM_CM_KEY: string
    let IS_WINDOWS: boolean

    if (process.platform === 'win32') {
        PLATFORM_DELIMITER = '\\'
        PLATFORM_META_KEY = 'Ctrl+'
        PLATFORM_CM_KEY = 'Ctrl'
        IS_WINDOWS = true
    } else if (process.platform === 'darwin') {
        PLATFORM_DELIMITER = '/'
        PLATFORM_META_KEY = '⌘'
        PLATFORM_CM_KEY = 'Cmd'
        IS_WINDOWS = false
    } else {
        PLATFORM_DELIMITER = '/'
        PLATFORM_META_KEY = 'Ctrl+'
        PLATFORM_CM_KEY = 'Ctrl'
        IS_WINDOWS = false
    }

    return {
        PLATFORM_DELIMITER,
        PLATFORM_META_KEY,
        PLATFORM_CM_KEY,
        IS_WINDOWS,
    }
}

export function join(a: string, b: string): string {
    if (a[a.length - 1] === connector.PLATFORM_DELIMITER) {
        return a + b
    }
    return a + connector.PLATFORM_DELIMITER + b
}

// make a join method that can handle ./ and ../
export function joinAdvanced(a: string, b: string): string {
    if (b.startsWith('./')) {
        return joinAdvanced(a, b.slice(2))
    }
    if (b.startsWith('../')) {
        // if a ends with slash
        if (a[a.length - 1] === connector.PLATFORM_DELIMITER) {
            a = a.slice(0, -1)
        }
        const aOneHigher = a.slice(
            0,
            a.lastIndexOf(connector.PLATFORM_DELIMITER)
        )
        return joinAdvanced(aOneHigher, b.slice(3))
    }
    return join(a, b)
}

export function removeBeginningAndEndingLineBreaks(str: string): string {
    str = str.trimEnd()
    while (str[0] === '\n') {
        str = str.slice(1)
    }
    while (str[str.length - 1] === '\n') {
        str = str.slice(0, -1)
    }
    return str
}
