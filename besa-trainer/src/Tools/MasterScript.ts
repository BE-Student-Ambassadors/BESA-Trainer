//The master script editor's non-UI logic: turning a whole floor's edited script back into timed VTT cues and
//section markers, with no AI - see timeMasterScript for the alignment algorithm.
import { alignWords, isLineInSection, normalizeWord, snapBoundariesToSentences, SENTENCE_END, type Line } from "./ScriptDecoder"
import type { Fill, Marker } from "./types"

//one top-level piece of the master script: a paragraph / bullet (its plain text - formatting doesn't go into the
//VTT), or a section break. A section break that came from an existing marker remembers that marker's time.
export type MasterItem =
    | {kind: "text", text: string}
    | {kind: "section", name: string, originalTime?: number}

export type TimedCue = Line & {item: number} //item = index of the MasterItem the cue came from

export type MasterTiming = {
    cues: TimedCue[]
    itemTimes: ({start: number, end: number} | null)[] //per item, null for sections / empty paragraphs
}

const MIN_CUE_SECONDS = 0.25
const FALLBACK_WORDS_PER_SECOND = 2.5
const MAX_UNTIMED_CUE_WORDS = 25

//Times every word of the master script against the draft's current VTT (the reference), then cuts cues:
//  1. word-level LCS between the new script and the reference transcript. Each reference word gets a time span by
//     splitting its cue's span evenly across that cue's words.
//  2. a matched word takes its reference word's exact time and cue. Unmatched words (rewording, additions) between
//     two matches are spread evenly over the reference words between those matches, so they follow the
//     speaker's local pace instead of a flat words-per-second guess.
//  3. each paragraph is cut into cues wherever its words move to a different reference cue, nudged to the nearest
//     sentence end - so unchanged text reproduces the original cues and times exactly (and highlights keep working).
//With no reference transcript at all, words are spread evenly over the video's length and cut at sentence ends.
export function timeMasterScript(items: MasterItem[], reference: Line[], videoDuration: number | null): MasterTiming {
    const tokens: string[] = []
    const tokenItem: number[] = []
    items.forEach((it, i) => {
        if (it.kind !== "text") return
        it.text.split(/\s+/).filter(Boolean).forEach(t => {
            tokens.push(t)
            tokenItem.push(i)
        })
    })
    const n = tokens.length
    const itemTimes: MasterTiming["itemTimes"] = items.map(() => null)
    if (n === 0) {
        return {cues: [], itemTimes}
    }

    const ref = reference.filter(l => l.text.trim()).sort((a, b) => a.start - b.start)
    const refWords: string[] = []
    const refStart: number[] = []
    const refEnd: number[] = []
    const refCueOf: number[] = []
    ref.forEach((cue, c) => {
        const words = cue.text.split(/\s+/).filter(Boolean)
        const span = Math.max(0, cue.end - cue.start)
        words.forEach((w, k) => {
            refWords.push(normalizeWord(w))
            refStart.push(cue.start + span * k / words.length)
            refEnd.push(k === words.length - 1 ? cue.end : cue.start + span * (k + 1) / words.length)
            refCueOf.push(c)
        })
    })
    const m = refWords.length

    const tokStart = new Array<number>(n)
    const tokEnd = new Array<number>(n)
    const tokCue = new Array<number>(n).fill(-1) //-1 = no reference cue (untimed fallback)

    if (m === 0) {
        const total = videoDuration && videoDuration > 0 ? videoDuration : n / FALLBACK_WORDS_PER_SECOND
        for (let k = 0; k < n; k++) {
            tokStart[k] = total * k / n
            tokEnd[k] = total * (k + 1) / n
        }
    } else {
        //each token gets a [xs, xe) span in "reference word" coordinates - word j covers [j, j+1).
        const xs = new Array<number>(n)
        const xe = new Array<number>(n)
        const anchors: [number, number][] = [[-1, -1], ...alignWords(tokens.map(normalizeWord), refWords), [n, m]]
        for (let a = 0; a < anchors.length - 1; a++) {
            const [ni, oi] = anchors[a]
            const [nj, oj] = anchors[a + 1]
            if (a > 0) {
                xs[ni] = oi
                xe[ni] = oi + 1
            }
            const run = nj - ni - 1
            const base = oi + 1
            const gap = oj - oi - 1
            for (let r = 0; r < run; r++) {
                xs[ni + 1 + r] = base + gap * r / run
                xe[ni + 1 + r] = base + gap * (r + 1) / run
            }
        }

        const timeAt = (x: number) => {
            const j = Math.floor(x)
            if (j >= m) return refEnd[m - 1]
            return refStart[j] + (x - j) * (refEnd[j] - refStart[j])
        }
        //a span ending exactly on a word boundary ends when that word ends, not when the next one starts
        const endTimeAt = (x: number) => Number.isInteger(x) && x > 0 ? refEnd[Math.min(x, m) - 1] : timeAt(x)

        for (let k = 0; k < n; k++) {
            tokStart[k] = timeAt(xs[k])
            tokEnd[k] = xe[k] > xs[k] ? endTimeAt(xe[k]) : tokStart[k]
            const mid = Math.min(m - 1, Math.max(0, Math.floor((xs[k] + xe[k]) / 2)))
            tokCue[k] = refCueOf[mid]
        }
    }

    const cues: TimedCue[] = []
    let k = 0
    while (k < n) {
        const item = tokenItem[k]
        let itemEnd = k
        while (itemEnd < n && tokenItem[itemEnd] === item) itemEnd++

        const boundaries = [k]
        if (m > 0) {
            for (let j = k + 1; j < itemEnd; j++) {
                if (tokCue[j] !== tokCue[j - 1]) boundaries.push(j)
            }
            boundaries.push(itemEnd)
            snapBoundariesToSentences(tokens, boundaries)
        } else {
            let pieceStart = k
            for (let j = k + 1; j < itemEnd; j++) {
                if (SENTENCE_END.test(tokens[j - 1]) || j - pieceStart >= MAX_UNTIMED_CUE_WORDS) {
                    boundaries.push(j)
                    pieceStart = j
                }
            }
            boundaries.push(itemEnd)
        }

        for (let b = 0; b < boundaries.length - 1; b++) {
            const from = boundaries[b]
            const to = boundaries[b + 1]
            if (to <= from) continue
            cues.push({item, start: tokStart[from], end: tokEnd[to - 1], text: tokens.slice(from, to).join(" ")})
        }
        k = itemEnd
    }

    //cues have to run forward in time without overlapping, and be long enough to actually read
    let prevEnd = -Infinity
    for (const cue of cues) {
        cue.start = Math.max(cue.start, prevEnd, 0)
        cue.end = Math.max(cue.end, cue.start + MIN_CUE_SECONDS)
        prevEnd = cue.end
    }

    for (const cue of cues) {
        const t = itemTimes[cue.item]
        itemTimes[cue.item] = t ? {start: t.start, end: cue.end} : {start: cue.start, end: cue.end}
    }
    return {cues, itemTimes}
}

//every section break becomes a marker. An existing marker keeps its exact time as long as it still splits the
//script at the same place (so nobody's progress is reset by a save that didn't move it); otherwise - or for a
//new section - it goes at the end of the last cue above the break, same as "<Section Name>" tags in the section editor.
export function sectionMarkers(items: MasterItem[], timing: MasterTiming): {markers: Marker[], errors: string[]} {
    const markers: Marker[] = []
    const errors: string[] = []
    const mid = (l: Line) => (l.start + l.end) / 2

    items.forEach((it, i) => {
        if (it.kind !== "section") return
        const name = it.name.trim()
        if (!name) {
            errors.push("A section break has no name.")
            return
        }
        const before = timing.cues.filter(c => c.item < i)
        const prev = before[before.length - 1]
        const next = timing.cues.find(c => c.item > i)

        let markTime: number
        const keepsPlace = it.originalTime !== undefined
            && (!prev || it.originalTime >= mid(prev))
            && (!next || it.originalTime < mid(next))
        if (keepsPlace) {
            markTime = it.originalTime!
        } else if (prev) {
            markTime = prev.end
        } else {
            errors.push(`Section "${name}" needs at least one line of script above it.`)
            return
        }

        if (markers.some(mk => mk.markerName === name)) {
            errors.push(`There are two sections named "${name}".`)
        } else if (markers.length > 0 && markTime <= markers[markers.length - 1].markTime) {
            errors.push(`Section "${name}" has no script between it and section "${markers[markers.length - 1].markerName}".`)
        } else {
            markers.push({markerName: name, markTime})
        }
    })
    return {markers, errors}
}

//a line that runs across a section marker is cut there, so each section gets the words actually spoken during it.
//Words are timed evenly across their line, each goes to the side of the marker its middle falls on, and the cut is
//nudged to a nearby sentence/clause end when there's one within two words. Returns how many lines were cut.
export function splitLinesAtMarkers(lines: Line[], markers: Marker[]): {lines: Line[], splitCount: number} {
    const times = markers.map(m => m.markTime).sort((a, b) => a - b)
    const out: Line[] = []
    let splitCount = 0
    for (const line of [...lines].sort((a, b) => a.start - b.start)) {
        const inside = times.filter(t => t > line.start && t < line.end)
        const words = line.text.split(/\s+/).filter(Boolean)
        if (inside.length === 0 || words.length < 2) {
            out.push(line)
            continue
        }
        const span = line.end - line.start
        const edges = [line.start, ...inside, line.end]
        const segmentOf = (k: number) => {
            const t = line.start + span * (k + 0.5) / words.length
            return edges.findIndex((_, e) => e < edges.length - 1 && t <= edges[e + 1])
        }
        const boundaries = [0]
        for (let s = 1; s < edges.length - 1; s++) {
            let b = 0
            while (b < words.length && segmentOf(b) < s) b++
            boundaries.push(Math.max(b, boundaries[boundaries.length - 1]))
        }
        boundaries.push(words.length)
        snapBoundariesToSentences(words, boundaries, 2)

        let pieces = 0
        for (let s = 0; s < edges.length - 1; s++) {
            const text = words.slice(boundaries[s], boundaries[s + 1]).join(" ")
            if (!text) continue
            out.push({start: edges[s], end: edges[s + 1], text})
            pieces++
        }
        if (pieces > 1) splitCount++
    }
    return {lines: out, splitCount}
}

//builds the master script's starting items from a draft's VTT and markers - one paragraph per cue (so saving
//without edits gives back the same cues), with each marker's break after the last cue in its section.
export function itemsFromVtt(lines: Line[], markers: Marker[]): MasterItem[] {
    const sortedLines = [...lines].sort((a, b) => a.start - b.start)
    const sortedMarkers = [...markers].sort((a, b) => a.markTime - b.markTime)
    const items: MasterItem[] = []
    let markerIdx = 0
    let lower = -Infinity
    for (const line of sortedLines) {
        //close every section this line comes after
        while (markerIdx < sortedMarkers.length && !isLineInSection(line, lower, sortedMarkers[markerIdx].markTime)) {
            const marker = sortedMarkers[markerIdx]
            items.push({kind: "section", name: marker.markerName, originalTime: marker.markTime})
            lower = marker.markTime
            markerIdx++
        }
        items.push({kind: "text", text: line.text})
    }
    for (; markerIdx < sortedMarkers.length; markerIdx++) {
        const marker = sortedMarkers[markerIdx]
        items.push({kind: "section", name: marker.markerName, originalTime: marker.markTime})
    }
    return items
}

//highlights (fill blanks) are tied to a cue's exact sentence and the section it's in. After a master save, a
//highlight whose sentence is unchanged follows it into whatever section it's in now; one whose sentence was
//reworded (or that has no section after it any more) is dropped, same as editing it away in the section editor.
export function resectionFills(fillings: Fill["fillings"], cues: Line[], markers: Marker[]): Fill["fillings"] {
    const sorted = [...markers].sort((a, b) => a.markTime - b.markTime)
    const kept: Fill["fillings"] = []
    for (const filling of fillings) {
        const cue = cues.find(c => c.text.trim() === filling.vttSectionSentenceFilled)
        const section = cue && sorted.find(mk => mk.markTime > cue.start)
        if (cue && section) {
            kept.push({...filling, section})
        }
    }
    return kept
}

export function formatClock(seconds: number): string {
    const m = Math.floor(seconds / 60)
    const s = seconds - m * 60
    return `${m}:${s.toFixed(1).padStart(4, "0")}`
}
