import { useEffect, useRef, useState, type MouseEvent } from "react"
import { collection, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc } from "firebase/firestore"
import { getStorage, ref, uploadBytes } from "firebase/storage"
import { db } from "../../Tools/firestore"
import { fetchGoogleDocScript, getScript, reconcileProgress, type GoogleDocBlock } from "../../Tools/Fetch"
import { getVtt, linesToVtt, type Line } from "../../Tools/ScriptDecoder"
import { formatClock, itemsFromVtt, resectionFills, sectionMarkers, splitLinesAtMarkers, timeMasterScript, type MasterItem } from "../../Tools/MasterScript"
import type { Fill, Floor, FloorCode, Marker, Script } from "../../Tools/types"
import { Loading } from "./Edit"

const FLOORS: {code: FloorCode, title: string}[] = [
    {code: "f1", title: "First Floor"},
    {code: "f2", title: "Second Floor"},
    {code: "f3", title: "Third Floor"},
    {code: "b", title: "Basement"},
    {code: "e", title: "Exit"},
]

//saved alongside each draft's VTT, so formatting (which the VTT can't hold) survives between visits. vtt and markers
//are what the script looked like when this was saved - if either changed since (in a floor's own section editor),
//the formatting is out of date and the editor starts again from the current script.
type MasterDoc = {
    draftId: string
    floorCode: FloorCode
    html: string
    vtt: string
    markers: Marker[]
    docUrl?: string
}

const EDITOR_STYLES = `
.ms-editor { outline: none; }
.ms-editor p { margin: 0.4rem 0; }
.ms-editor ul { list-style: disc; padding-left: 1.75rem; margin: 0.4rem 0; }
.ms-editor ol { list-style: decimal; padding-left: 1.75rem; margin: 0.4rem 0; }
.ms-editor li { margin: 0.2rem 0; }
.ms-editor.ms-show-times p[data-time]::before, .ms-editor.ms-show-times li[data-time]::before {
    content: attr(data-time); display: inline-block; margin-right: 0.5rem; padding: 0 0.4rem; border-radius: 9999px;
    font: 600 0.7rem/1.3rem ui-monospace, monospace; color: #fbbf24; background: rgba(17, 24, 39, 0.8); user-select: none;
}
.ms-section { display: flex; align-items: center; gap: 0.5rem; margin: 0.9rem 0; user-select: none; }
.ms-section::before, .ms-section::after { content: ""; flex: 1; border-top: 2px solid #fbbf24; }
.ms-section-label { color: #fbbf24; font-size: 0.8rem; font-weight: 700; background: rgba(17, 24, 39, 0.8); padding: 0.1rem 0.6rem; border-radius: 9999px; cursor: pointer; white-space: nowrap; }
.ms-section-time { display: none; color: #fde68a; font: 600 0.7rem ui-monospace, monospace; }
.ms-editor.ms-show-times .ms-section-time { display: inline; }
.ms-section-remove { color: #fca5a5; font-size: 0.75rem; padding: 0 0.4rem; border-radius: 9999px; }
.ms-section-remove:hover { background: rgba(127, 29, 29, 0.6); }
`

//the master script editor - every floor's whole script on one long page. Editing here rewrites that draft's VTT
//(and so the script every section shows), its section markers, and keeps its highlights where their sentence survived.
//Highlights themselves are only made in each floor's own section editor.
export default function MasterScriptEditor() {
    return (
        <div className="w-full text-gray-200 pb-24">
            <style>{EDITOR_STYLES}</style>
            <div className="w-11/12 lg:w-5/6 mx-auto pt-6">
                <h1 className="text-3xl tracking-wider">Master Script Editor</h1>
                <p className="text-gray-400 mt-2 max-w-3xl">
                    Edit a floor's whole script at once. Saving updates the script in every section of that draft and lines the
                    text up with the video's timing automatically. Section breaks can be added and moved here.
                    Highlights (fill-in-the-blank) are still made in each floor's own editor.
                </p>
            </div>
            {FLOORS.map(floor => <FloorMaster key={floor.code} code={floor.code} title={floor.title}/>)}
        </div>
    )
}

function FloorMaster({code, title}: {code: FloorCode, title: string}) {
    const [drafts, setDrafts] = useState<Floor[] | null>(null)
    const [selectedId, setSelectedId] = useState<string | null>(null)

    useEffect(() => {
        getDocs(collection(db, "training_data", "floors", code)).then(snap => {
            const list = snap.docs.map(d => d.data() as Floor)
            setDrafts(list)
            setSelectedId((list.find(d => d.current) || list[0])?.id ?? null)
        }).catch(e => {
            console.error(e)
            setDrafts([])
        })
    }, [code])

    const selected = drafts?.find(d => d.id === selectedId) || null

    return (
        <section className="w-11/12 lg:w-5/6 mx-auto mt-14">
            <div className="flex flex-wrap items-end justify-between gap-3 border-b-2 border-amber-500 pb-2">
                <h2 className="text-5xl font-bold tracking-wide text-white">{title}</h2>
                {drafts && drafts.length > 0 &&
                    <label className="flex items-center gap-2 text-sm">
                        <span className="text-gray-400">Draft:</span>
                        <select value={selectedId ?? ""} onChange={({target}) => setSelectedId(target.value)}
                            className="bg-gray-800 border border-gray-500 rounded-full px-3 py-1.5 text-gray-100">
                            {drafts.map(d => <option key={d.id} value={d.id}>{d.draftName}{d.current ? " (default)" : ""}</option>)}
                        </select>
                    </label>
                }
            </div>
            {drafts === null ? <p className="text-gray-400 mt-4 animate-pulse">Loading drafts...</p>
                : !selected ? <p className="text-gray-400 mt-4">No drafts yet. Upload a video for this floor in its section editor first.</p>
                : <DraftMasterEditor key={selected.id} draft={selected}
                    onMarkersSaved={markers => setDrafts(prev => prev?.map(d => d.id === selected.id ? {...d, markers} : d) ?? prev)}/>
            }
        </section>
    )
}

type DomItem = {item: MasterItem, el: HTMLElement}

function DraftMasterEditor({draft, onMarkersSaved}: {draft: Floor, onMarkersSaved: (markers: Marker[]) => void}) {
    const editorRef = useRef<HTMLDivElement>(null)
    const retimeTimer = useRef<number | undefined>(undefined)
    const [script, setScript] = useState<Script | null>(null)
    const [reference, setReference] = useState<Line[]>([]) //the draft's VTT as last loaded/saved - what timing aligns against
    const [savedMarkers, setSavedMarkers] = useState<Marker[]>(draft.markers)
    const [duration, setDuration] = useState<number | null>(null)
    const [loading, setLoading] = useState(true)
    const [showTimes, setShowTimes] = useState(true)
    const [dirty, setDirty] = useState(false)
    const [saving, setSaving] = useState(false)
    const [importing, setImporting] = useState(false)
    const [docUrl, setDocUrl] = useState("")
    const [notice, setNotice] = useState("")
    const [errors, setErrors] = useState<string[]>([])
    const [summary, setSummary] = useState("")

    //puts a freshly loaded draft into the editor - its saved formatting if that's still current, else the plain script
    function applyLoaded(loaded: LoadedDraft | null) {
        if (!loaded) {
            setNotice("Couldn't load this draft's script.")
            setLoading(false)
            return
        }
        const {script: s, vttText, master} = loaded
        //lines that run across a section marker are cut at it first - otherwise the words spoken during a short
        //section all sit in one line that belongs to a neighbouring section, and the section looks empty
        const {lines, splitCount} = splitLinesAtMarkers(safeVtt(vttText), draft.markers)
        const upToDate = master && splitCount === 0 && master.vtt === vttText && sameMarkers(master.markers || [], draft.markers)
        const notes: string[] = []
        if (splitCount > 0) {
            notes.push(`${splitCount} line${splitCount > 1 ? "s" : ""} ran across a section break, so ${splitCount > 1 ? "they were" : "it was"} split at the break to give each section the words spoken during it. Press Save to keep this. A highlight on a split line will be removed, so re-add it in the section editor.`)
        }
        if (master && (master.vtt !== vttText || !sameMarkers(master.markers || [], draft.markers))) {
            notes.push("This script was changed in a section editor since the master script was last saved, so it was reloaded from the current script and its bold/italic/bullets were reset.")
        }
        setNotice(notes.join(" "))
        if (master?.docUrl) setDocUrl(master.docUrl)
        setScript(s)
        setReference(lines)
        setSavedMarkers(draft.markers)
        if (editorRef.current) {
            editorRef.current.innerHTML = upToDate && master ? sanitizeHtml(master.html) : itemsToHtml(itemsFromVtt(lines, draft.markers))
            ensureParagraph(editorRef.current)
        }
        setDirty(splitCount > 0)
        setLoading(false)
    }

    useEffect(() => {
        let cancelled = false
        fetchDraft(draft).then(loaded => {
            if (!cancelled) applyLoaded(loaded)
        })
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft.id])

    //live timing - re-run whenever the text, the reference script or the video length changes
    useEffect(() => {
        if (!loading) retime()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, reference, duration])

    function computeTiming() {
        const domItems = readItems(editorRef.current!)
        const items = domItems.map(d => d.item)
        const timing = timeMasterScript(items, reference, duration)
        return {domItems, items, timing, ...sectionMarkers(items, timing)}
    }

    //writes each paragraph's and section break's lined-up time onto it (shown when timestamps are on)
    function retime() {
        if (!editorRef.current) return
        const {domItems, timing, markers, errors} = computeTiming()
        domItems.forEach((d, i) => {
            if (d.item.kind === "text") {
                const t = timing.itemTimes[i]
                if (t) d.el.dataset.time = `${formatClock(t.start)} - ${formatClock(t.end)}`
                else delete d.el.dataset.time
            } else {
                const name = d.item.name.trim()
                const marker = markers.find(mk => mk.markerName === name)
                const timeEl = d.el.querySelector(".ms-section-time")
                if (timeEl) timeEl.textContent = marker ? `at ${formatClock(marker.markTime)}` : ""
            }
        })
        setErrors(errors)
        setSummary(`${timing.cues.length} timed line${timing.cues.length === 1 ? "" : "s"}, ${markers.length} section${markers.length === 1 ? "" : "s"}` +
            (reference.length === 0 ? ` - no transcript to line up with, so the text is spread evenly over the video${duration ? ` (${formatClock(duration)})` : ""}` : ""))
    }

    function scheduleRetime() {
        window.clearTimeout(retimeTimer.current)
        retimeTimer.current = window.setTimeout(retime, 350)
    }

    function handleInput() {
        if (editorRef.current) wrapStrayInline(editorRef.current)
        setDirty(true)
        scheduleRetime()
    }

    //formatting buttons act on the editor's selection, so they mustn't steal focus from it
    function format(command: "bold" | "italic" | "removeFormat" | "insertUnorderedList") {
        editorRef.current?.focus()
        document.execCommand("styleWithCSS", false, "false")
        document.execCommand(command)
        handleInput()
    }

    function addSection() {
        const name = window.prompt("Name of the section that ends here:")?.trim()
        if (!name || !editorRef.current) return
        insertSectionBreak(editorRef.current, makeDivider(name))
        handleInput()
    }

    //clicks inside a section break: rename it or remove it
    function handleEditorClick(e: MouseEvent<HTMLDivElement>) {
        const target = e.target as HTMLElement
        const divider = target.closest<HTMLElement>("[data-section]")
        if (!divider) return
        if (target.closest(".ms-section-remove")) {
            divider.remove()
            handleInput()
        } else if (target.closest(".ms-section-label")) {
            const name = window.prompt("Rename section:", divider.dataset.section)?.trim()
            if (name) {
                divider.dataset.section = name
                divider.querySelector(".ms-section-label")!.textContent = name
                handleInput()
            }
        }
    }

    //pasting keeps only the text, so whatever was copied doesn't bring its own styling into the script
    function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
        e.preventDefault()
        document.execCommand("insertText", false, e.clipboardData.getData("text/plain"))
    }

    async function handleImport() {
        if (!docUrl.trim() || !editorRef.current) return
        const hasText = readItems(editorRef.current).some(d => d.item.kind === "text")
        if (hasText && !window.confirm("Replace this floor's script in the editor with the Google Doc? Nothing is saved until you press Save.")) return
        setImporting(true)
        setNotice("")
        const result = await fetchGoogleDocScript(docUrl.trim())
        setImporting(false)
        if (!result.success || !result.blocks) {
            setNotice(result.detail || "Couldn't read that doc.")
            return
        }
        const editor = editorRef.current
        editor.innerHTML = blocksToHtml(result.blocks, savedMarkers)
        ensureParagraph(editor)
        const notes = []
        if (!result.formatted) notes.push("Only the doc's plain text could be read, so bold/italic weren't brought over. Share the doc with the connected Google account (or reconnect it) to keep formatting.")
        if (!result.blocks.some(b => b.type === "heading") && savedMarkers.length > 0) {
            placeExistingSections(editor, savedMarkers, reference, duration)
            notes.push("The doc has no headings, so this floor's current sections were placed at the nearest paragraph break. Check them before saving.")
        } else if (result.blocks.some(b => b.type === "heading")) {
            notes.push("Each heading in the doc became a section break at the end of the text under it.")
        }
        setNotice(notes.join(" "))
        handleInput()
        retime()
    }

    async function handleSave() {
        if (!editorRef.current) return
        if (!script) {
            setErrors(["This draft has no script file yet. Open it in the floor's section editor first."])
            return
        }
        const {domItems, timing, markers, errors} = computeTiming()
        setErrors(errors)
        if (errors.length > 0) return
        if (timing.cues.length === 0) {
            setErrors(["The script is empty."])
            return
        }
        const removed = savedMarkers.filter(old => !markers.some(mk => mk.markerName === old.markerName))
        if (removed.length > 0 && !window.confirm(`This removes the section${removed.length > 1 ? "s" : ""} ${removed.map(m => `"${m.markerName}"`).join(", ")}, and trainees' progress on ${removed.length > 1 ? "them" : "it"}. Save anyway?`)) return

        setSaving(true)
        try {
            const cues = timing.cues.map(({start, end, text}) => ({start, end, text}))
            const vtt = linesToVtt(cues)
            await uploadBytes(ref(getStorage(), "scripts/" + script.id), new Blob([vtt], {type: "text/vtt"}))

            if (!sameMarkers(markers, savedMarkers)) {
                await updateDoc(doc(db, "training_data", "floors", draft.floorCode, draft.id), {markers})
                //same as moving a marker in the video editor - keep everyone's progress lined up with the markers
                reconcileProgress(draft.id, markers.map(mk => mk.markTime))
                onMarkersSaved(markers)
            }

            let fillNote = ""
            const fillRef = doc(db, "training_data", "data_root", "fills", draft.id)
            const fillSnap = await getDoc(fillRef)
            if (fillSnap.exists()) {
                const fill = fillSnap.data() as Fill
                const kept = resectionFills(fill.fillings, cues, markers)
                if (JSON.stringify(kept) !== JSON.stringify(fill.fillings)) {
                    await updateDoc(fillRef, {fillings: kept})
                }
                const dropped = fill.fillings.length - kept.length
                if (dropped > 0) fillNote = ` ${dropped} highlighted sentence${dropped > 1 ? "s were" : " was"} reworded or moved out of every section, so ${dropped > 1 ? "their" : "its"} highlights were removed.`
            }

            //later saves should keep these exact marker times unless a break is moved again
            domItems.forEach(d => {
                if (d.item.kind !== "section") return
                const name = d.item.name.trim()
                const marker = markers.find(mk => mk.markerName === name)
                if (marker) d.el.dataset.markTime = String(marker.markTime)
            })

            const master: MasterDoc & {updatedAt: unknown} = {
                draftId: draft.id, floorCode: draft.floorCode, html: sanitizeHtml(editorRef.current.innerHTML),
                vtt, markers, docUrl: docUrl.trim(), updatedAt: serverTimestamp()
            }
            await setDoc(doc(db, "training_data", "data_root", "master_scripts", draft.id), master)

            setSavedMarkers(markers)
            setReference(safeVtt(vtt))
            setDirty(false)
            setNotice(`Saved ${cues.length} lines and ${markers.length} sections.${fillNote}`)
        } catch (e) {
            console.error(e)
            setErrors(["Saving failed. Please try again."])
        } finally {
            setSaving(false)
        }
    }

    function handleDiscard() {
        if (dirty && !window.confirm("Throw away your unsaved changes to this floor's script?")) return
        setLoading(true)
        setNotice("")
        setErrors([])
        fetchDraft(draft).then(applyLoaded)
    }

    const toolButton = "px-3 py-1.5 rounded-full bg-gray-800 hover:bg-gray-900 text-sm"

    return (
        <div className="mt-4 bg-gray-700 rounded-2xl p-4">
            {/* only here to learn the video's length, for scripts with no transcript to line up with */}
            <video src={draft.src} preload="metadata" className="hidden" onLoadedMetadata={e => setDuration(e.currentTarget.duration || null)}/>

            <div className="flex flex-wrap items-center gap-2">
                <input type="url" value={docUrl} onChange={({target}) => setDocUrl(target.value)} placeholder="Google Doc link..."
                    className="flex-1 min-w-[16rem] bg-gray-800 border border-gray-500 rounded-full px-4 py-1.5 text-sm"/>
                <button className="px-4 py-1.5 rounded-full bg-blue-800 hover:bg-blue-900 text-sm disabled:opacity-50" disabled={!docUrl.trim() || importing}
                    onClick={handleImport}>{importing ? "Importing..." : "Import from Google Doc"}</button>
            </div>

            <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 mt-3 py-2 bg-gray-700">
                <button className={toolButton + " font-bold"} onMouseDown={e => e.preventDefault()} onClick={() => format("bold")} title="Bold">B</button>
                <button className={toolButton + " italic"} onMouseDown={e => e.preventDefault()} onClick={() => format("italic")} title="Italic">I</button>
                <button className={toolButton} onMouseDown={e => e.preventDefault()} onClick={() => format("removeFormat")} title="Regular text">Regular</button>
                <button className={toolButton} onMouseDown={e => e.preventDefault()} onClick={() => format("insertUnorderedList")} title="Bullet list">&bull; Bullets</button>
                <span className="w-px h-6 bg-gray-500 mx-1"/>
                <button className={toolButton} onMouseDown={e => e.preventDefault()} onClick={addSection} title="End a section after the line your cursor is on">+ Section Break</button>
                <span className="w-px h-6 bg-gray-500 mx-1"/>
                <button className={toolButton + (showTimes ? " ring-2 ring-amber-400" : "")} onClick={() => setShowTimes(v => !v)}>
                    {showTimes ? "Hide Timestamps" : "Show Timestamps"}
                </button>
                <button className={toolButton} onClick={retime} title="Line the text up with the video's timing again">Line Up Timestamps</button>
                <div className="ml-auto flex items-center gap-2">
                    <button className={toolButton} onClick={handleDiscard}>Discard Changes</button>
                    <button className="px-4 py-1.5 rounded-full bg-amber-600 hover:bg-amber-700 text-black font-bold text-sm disabled:opacity-50"
                        disabled={!dirty || saving || loading} onClick={handleSave}>
                        Save Script
                    </button>
                </div>
            </div>

            {notice && <p className="text-sm text-amber-300 mt-2">{notice}</p>}
            {errors.map((err, i) => <p key={i} className="text-sm text-red-300 mt-1">{err}</p>)}

            <div className="relative mt-2">
                <div ref={editorRef} contentEditable={!loading} suppressContentEditableWarning spellCheck
                    onInput={handleInput} onClick={handleEditorClick} onPaste={handlePaste}
                    className={"ms-editor min-h-[16rem] bg-gray-800 rounded-2xl p-4 leading-relaxed text-gray-100" + (showTimes ? " ms-show-times" : "") + (loading ? " opacity-40" : "")}/>
                {loading && <p className="absolute inset-0 flex items-center justify-center text-gray-300 animate-pulse">Loading script...</p>}
            </div>
            <p className="text-xs text-gray-400 mt-2">
                {summary}{dirty ? " - unsaved changes" : ""}. Timestamps are worked out automatically: text you kept keeps its exact time in the
                video, and new or reworded text follows the pace of what was said around it. Click a section's name to rename it.
            </p>
            {saving && <Loading text="Saving script..."/>}
        </div>
    )
}

type LoadedDraft = {script: Script | null, vttText: string, master: MasterDoc | null}

async function fetchDraft(draft: Floor): Promise<LoadedDraft | null> {
    try {
        const scriptSnap = await getDoc(doc(db, "training_data", "data_root", "scripts", draft.defScriptId))
        const script = scriptSnap.exists() ? scriptSnap.data() as Script : null
        const vttText = script ? (await getScript(script.src)) || "" : ""
        const masterSnap = await getDoc(doc(db, "training_data", "data_root", "master_scripts", draft.id))
        return {script, vttText, master: masterSnap.exists() ? masterSnap.data() as MasterDoc : null}
    } catch (e) {
        console.error(e)
        return null
    }
}

function safeVtt(text: string): Line[] {
    try {
        return text.trim() ? getVtt(text) : []
    } catch (e) {
        console.error(e)
        return []
    }
}

function sameMarkers(a: Marker[], b: Marker[]): boolean {
    const key = (list: Marker[]) => JSON.stringify([...list].sort((x, y) => x.markTime - y.markTime).map(m => [m.markerName, m.markTime]))
    return key(a) === key(b)
}

//---- editor DOM helpers ----

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function makeDivider(name: string, markTime?: number): HTMLElement {
    const el = document.createElement("div")
    el.className = "ms-section"
    el.contentEditable = "false"
    el.dataset.section = name
    if (markTime !== undefined) el.dataset.markTime = String(markTime)
    const label = document.createElement("span")
    label.className = "ms-section-label"
    label.title = "Click to rename"
    label.textContent = name
    const time = document.createElement("span")
    time.className = "ms-section-time"
    const remove = document.createElement("button")
    remove.type = "button"
    remove.className = "ms-section-remove"
    remove.title = "Remove this section break"
    remove.textContent = "Remove"
    el.append(label, time, remove)
    return el
}

function itemsToHtml(items: MasterItem[]): string {
    const holder = document.createElement("div")
    for (const item of items) {
        if (item.kind === "section") {
            holder.appendChild(makeDivider(item.name, item.originalTime))
        } else {
            const p = document.createElement("p")
            p.textContent = item.text
            holder.appendChild(p)
        }
    }
    return holder.innerHTML
}

//a Google Doc's blocks as editor HTML. A heading names the section made of the text under it, so its break goes
//after that text (a marker ends its section). An existing section with the same name keeps its time if it still fits.
function blocksToHtml(blocks: GoogleDocBlock[], markers: Marker[]): string {
    const holder = document.createElement("div")
    let list: HTMLUListElement | null = null
    let pendingSection: string | null = null
    const closeSection = () => {
        if (pendingSection) {
            const existing = markers.find(m => m.markerName === pendingSection)
            holder.appendChild(makeDivider(pendingSection, existing?.markTime))
        }
        pendingSection = null
    }
    for (const block of blocks) {
        const html = block.runs.map(r => {
            let text = escapeHtml(r.text)
            if (r.bold) text = `<b>${text}</b>`
            if (r.italic) text = `<i>${text}</i>`
            return text
        }).join("").trim()
        if (block.type === "heading") {
            list = null
            closeSection()
            pendingSection = block.runs.map(r => r.text).join("").trim() || null
            continue
        }
        if (block.type === "li") {
            if (!list) {
                list = document.createElement("ul")
                holder.appendChild(list)
            }
            const li = document.createElement("li")
            li.innerHTML = html
            list.appendChild(li)
        } else {
            list = null
            const p = document.createElement("p")
            p.innerHTML = html
            holder.appendChild(p)
        }
    }
    closeSection()
    return holder.innerHTML
}

//the doc had no headings - put each of the floor's current sections back after the paragraph its time falls in
function placeExistingSections(editor: HTMLElement, markers: Marker[], reference: Line[], duration: number | null) {
    const domItems = readItems(editor)
    const timing = timeMasterScript(domItems.map(d => d.item), reference, duration)
    for (const marker of [...markers].sort((a, b) => a.markTime - b.markTime)) {
        let after: HTMLElement | null = null
        for (let i = 0; i < domItems.length; i++) {
            const t = timing.itemTimes[i]
            if (t && (t.start + t.end) / 2 <= marker.markTime) after = domItems[i].el
        }
        const divider = makeDivider(marker.markerName, marker.markTime)
        if (after) placeAfterBlock(after, divider)
        else editor.prepend(divider)
    }
}

//only what the editor itself makes is kept - paragraphs, bullets, bold, italic and section breaks
function sanitizeHtml(html: string): string {
    const source = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body
    const out = document.createElement("div")
    const copy = (from: Node, to: HTMLElement) => {
        for (const node of Array.from(from.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) {
                to.appendChild(document.createTextNode(node.textContent || ""))
                continue
            }
            if (!(node instanceof HTMLElement) || ["SCRIPT", "STYLE", "TEMPLATE"].includes(node.tagName)) continue
            if (node.dataset.section !== undefined) {
                const time = node.dataset.markTime !== undefined ? Number(node.dataset.markTime) : undefined
                to.appendChild(makeDivider(node.dataset.section, Number.isFinite(time) ? time : undefined))
                continue
            }
            const tag = {P: "p", DIV: "p", H1: "p", H2: "p", H3: "p", UL: "ul", OL: "ol", LI: "li", B: "b", STRONG: "b", I: "i", EM: "i", BR: "br"}[node.tagName]
            if (!tag) {
                copy(node, to) //unknown wrapper (span etc.) - keep its contents only
                continue
            }
            const el = document.createElement(tag)
            to.appendChild(el)
            copy(node, el)
        }
    }
    copy(source, out)
    return out.innerHTML
}

const BLOCK_TAGS = new Set(["P", "DIV", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE"])

//the editor's content as master script items, in order, each with the element it came from
function readItems(root: HTMLElement): DomItem[] {
    const out: DomItem[] = []
    const visit = (parent: Element) => {
        for (const child of Array.from(parent.children)) {
            const el = child as HTMLElement
            if (el.dataset.section !== undefined) {
                const time = el.dataset.markTime !== undefined ? Number(el.dataset.markTime) : undefined
                out.push({item: {kind: "section", name: el.dataset.section, originalTime: Number.isFinite(time) ? time : undefined}, el})
            } else if (el.tagName === "UL" || el.tagName === "OL") {
                visit(el)
            } else if (BLOCK_TAGS.has(el.tagName)) {
                const hasBlocks = Array.from(el.children).some(c => BLOCK_TAGS.has(c.tagName) || c.tagName === "UL" || c.tagName === "OL" || (c as HTMLElement).dataset.section !== undefined)
                if (hasBlocks) visit(el)
                else out.push({item: {kind: "text", text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim()}, el})
            }
        }
    }
    visit(root)
    return out
}

function ensureParagraph(editor: HTMLElement) {
    if (!editor.firstChild) editor.innerHTML = "<p><br></p>"
}

//typing into an emptied editor can leave bare text right under it - wrap that in a paragraph (keeping the caret
//where it was) so it's part of the script like everything else.
function wrapStrayInline(editor: HTMLElement) {
    const stray = Array.from(editor.childNodes).filter(n =>
        (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) || (n instanceof HTMLElement && ["B", "I", "STRONG", "EM", "SPAN"].includes(n.tagName)))
    if (stray.length === 0) return
    const sel = window.getSelection()
    const anchor = sel?.anchorNode
    const offset = sel?.anchorOffset ?? 0
    const p = document.createElement("p")
    stray[0].before(p)
    stray.forEach(n => p.appendChild(n))
    if (sel && anchor && p.contains(anchor)) sel.collapse(anchor, offset)
}

//puts an element right after a block. A bullet splits its list in two around the element.
function placeAfterBlock(block: HTMLElement, el: HTMLElement) {
    const list = block.parentElement
    if (block.tagName === "LI" && list && (list.tagName === "UL" || list.tagName === "OL")) {
        const rest = list.cloneNode(false) as HTMLElement
        while (block.nextSibling) rest.appendChild(block.nextSibling)
        list.after(el)
        if (rest.childNodes.length > 0) el.after(rest)
    } else {
        block.after(el)
    }
}

//a new section break goes after the line the caret is on (or at the very end), with a paragraph after it to keep typing in
function insertSectionBreak(editor: HTMLElement, divider: HTMLElement) {
    const anchor = window.getSelection()?.anchorNode
    let block: HTMLElement | null = anchor && editor.contains(anchor) && anchor !== editor
        ? (anchor.nodeType === Node.ELEMENT_NODE ? anchor as HTMLElement : anchor.parentElement)
        : null
    while (block && block.parentElement !== editor && block.tagName !== "LI") block = block.parentElement
    if (block && block.parentElement && block.tagName === "LI" && block.parentElement.parentElement !== editor) {
        block = block.parentElement //a bullet nested deeper than one list - just go after its list
    }
    if (block) placeAfterBlock(block, divider)
    else editor.appendChild(divider)
    if (!divider.nextElementSibling) {
        const p = document.createElement("p")
        p.innerHTML = "<br>"
        divider.after(p)
    }
}
