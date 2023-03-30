import { useState, useEffect, useRef } from 'react'
import { Combobox } from '@headlessui/react'
import { getIconElement } from './filetree'
import { openFile } from '../features/globalSlice'
import { useAppDispatch, useAppSelector } from '../app/hooks'
import { getRootPath, searchAllFiles, searchFile } from '../features/selectors'
import { untriggerFileSearch } from '../features/tools/toolSlice'
import { fileSearchTriggered } from '../features/tools/toolSelectors'

interface FileResult {
    filename: string
    path: string
}

export default function SearchFiles() {
    const [selected, setSelected] = useState<FileResult>()
    const [query, setQuery] = useState('')
    const [showing, setShowing] = useState(false)
    const [selectedIndex, setSelectedIndex] = useState(0)
    const [results, setResults] = useState<string[]>([])
    const [childQuery, setChildQuery] = useState('')
    // const results = useAppSelector(searchFile(query))
    const comboRef = useRef<HTMLInputElement>(null)

    if (selectedIndex != 0 && selectedIndex >= results.length) {
        setSelectedIndex(results.length - 1)
    }

    const triggerFileSearchFocus = useAppSelector(fileSearchTriggered)
    const dispatch = useAppDispatch()

    useEffect(() => {
        searchAllFiles(query).then((results) => {
            setResults(results)
            setChildQuery(query)
        })
    }, [query])

    useEffect(() => {
        if (triggerFileSearchFocus) {
            dispatch(untriggerFileSearch())
            setShowing(true)
            setSelectedIndex(0)
        }
    }, [triggerFileSearchFocus, comboRef.current])

    // effect for when becomes unfocused
    useEffect(() => {
        if (showing && comboRef.current) {
            comboRef.current.focus()
            const handleBlur = (event: any) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                    setTimeout(() => {
                        // setShowing(false)
                    }, 200)
                    //setShowing(false);
                }
            }
            comboRef.current.addEventListener('blur', handleBlur)
            return () => {
                comboRef.current?.removeEventListener('blur', handleBlur)
            }
        }
    }, [showing, comboRef.current])

    useEffect(() => {
        const selectedElement = document.querySelector('.file__line_selected')
        selectedElement?.scrollIntoView({ block: 'center' })
    }, [selectedIndex]) // Only run when selectedIndex changes

    return (
        <>
            {showing && (
                <div
                    className="absolute top-2.5 left-1/2 
                transform -translate-x-1/2 z-50"
                    style={{ display: showing ? 'block' : 'none' }}
                    id="fileSearchId"
                >
                    <Combobox value={selected} onChange={setSelected}>
                        <Combobox.Input
                            className="w-[36rem] bg-neutral-700 rounded-md 
                        text-white py-0.5 px-1 !outline-none"
                            placeholder={'Search files...'}
                            displayValue={(file: FileResult) => file.filename}
                            onChange={(event: any) => {
                                setQuery(event.target.value)
                                setSelectedIndex(0)
                            }}
                            onKeyDown={(e: any) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault()
                                    // click on the selected item
                                    if (results[selectedIndex]) {
                                        dispatch(
                                            openFile({
                                                filePath:
                                                    results[selectedIndex],
                                            })
                                        )
                                        setShowing(false)
                                    }
                                }
                                if (e.key === 'ArrowDown') {
                                    e.preventDefault()
                                    if (selectedIndex >= results.length - 1) {
                                        setSelectedIndex(0)
                                    } else {
                                        setSelectedIndex(
                                            Math.min(
                                                selectedIndex + 1,
                                                results.length - 1
                                            )
                                        )
                                    }
                                } else if (e.key === 'ArrowUp') {
                                    e.preventDefault()
                                    if (selectedIndex <= 0) {
                                        setSelectedIndex(results.length - 1)
                                    } else {
                                        setSelectedIndex(
                                            Math.max(0, selectedIndex - 1)
                                        )
                                    }
                                } else if (e.key === 'Escape') {
                                    e.preventDefault()
                                    setShowing(false)
                                }
                            }}
                            ref={comboRef}
                        />
                        <Combobox.Options
                            className="absolute mt-1 max-h-60 w-full 
                        overflow-auto rounded-md bg-neutral-800 border-white 
                        border-opacity-20 border"
                        >
                            {results.map((path: string, index: number) => (
                                <SearchResult
                                    key={path}
                                    query={childQuery}
                                    path={path}
                                    isSelected={index == selectedIndex}
                                />
                            ))}
                        </Combobox.Options>
                    </Combobox>
                </div>
            )}
        </>
    )
}

export function SearchResult({
    query,
    path,
    isSelected,
}: {
    query: string
    path: string
    isSelected: boolean
}) {
    const dispatch = useAppDispatch()
    const rootPath = useAppSelector(getRootPath)
    const iconElement = getIconElement(path)

    // Now paths are relative to the root path

    let splitFilePath = path.split(connector.PLATFORM_DELIMITER)
    let fileName = splitFilePath.pop()!
    let precedingPath = splitFilePath
        .join(connector.PLATFORM_DELIMITER)
        .slice(rootPath!.length + 1)

    const changeFile = (path: string) => {
        dispatch(openFile({ filePath: path }))
    }
    let className = 'file__line'
    if (isSelected) {
        className += ' file__line_selected'
    }
    return (
        <div className={className} onClick={() => changeFile(path)}>
            <div className="file__icon">{iconElement}</div>
            <div className="file__name">
                {fileName
                    .split(new RegExp(`(${query})`, 'gi'))
                    .map((part, index) =>
                        part.toLowerCase() === query.toLowerCase() ? (
                            <mark key={index}>{part}</mark>
                        ) : (
                            <span key={index}>{part}</span>
                        )
                    )}
            </div>
            <div className="file__path">
                {(() => {
                    try {
                        return precedingPath
                            .split(new RegExp(`(${query})`, 'gi'))
                            .map((part, index) =>
                                part.toLowerCase() === query.toLowerCase() ? (
                                    <mark key={index}>{part}</mark>
                                ) : (
                                    <span key={index}>{part}</span>
                                )
                            )
                    } catch (e) {
                        return precedingPath
                    }
                })()}
            </div>
        </div>
    )
}
