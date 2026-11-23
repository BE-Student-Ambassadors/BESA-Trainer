import type { TaskNote } from "./Fetch"

//"Fri, Nov 21" or "Fri, Nov 21, 3:30 PM" - the deadline is a Pacific wall-clock date (and time), shown as written.
//A plain date is read at noon so it stays on the right day.
export function formatDeadline(deadline: string): string {
    const [day, time] = deadline.split("T")
    const date = new Date(`${day}T${time || "12:00"}:00`)
    const dayText = date.toLocaleDateString(undefined, {weekday: "short", month: "short", day: "numeric"})
    return time ? `${dayText}, ${date.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})}` : dayText
}

//a note's priority and deadline as one short line ("High priority · Due Fri, Nov 21"), for spots too small for the
//badges - the kiosk's task chips and Current Sessions pills. Null when the note has neither.
export function taskNoteSummary(note: TaskNote | undefined): {text: string, overdue: boolean} | null {
    if (!note || (!note.priority && !note.deadline)) return null
    const parts: string[] = []
    if (note.priority) parts.push(note.priority[0].toUpperCase() + note.priority.slice(1) + " priority")
    if (note.deadline) parts.push((note.overdue ? "Overdue - was due " : "Due ") + formatDeadline(note.deadline))
    return {text: parts.join(" · "), overdue: note.overdue}
}

//notes with a deadline whose checklist isn't finished yet - overdue ones first, then soonest due. A plain date is
//due at the end of that day, so it sorts after any time on that day.
export function dueTaskNotes(notes: TaskNote[]): TaskNote[] {
    const dueKey = (deadline: string) => deadline.includes("T") ? deadline : `${deadline}T24:00`
    return notes
        .filter(n => n.deadline && !(n.items.length > 0 && n.items.every(i => i.done)))
        .sort((a, b) => Number(b.overdue) - Number(a.overdue) || dueKey(a.deadline!).localeCompare(dueKey(b.deadline!)))
}
