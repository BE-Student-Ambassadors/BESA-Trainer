import { useEffect, useState, type JSX } from "react"
import { Link } from "react-router-dom"
import { MoonLoader } from "react-spinners"
import { FaClipboardList } from "react-icons/fa"
import TaskNoteCard from "./TaskNoteCard"
import { checkAutoClockout, checkTaskNoteItem, type TaskNote } from "../Tools/Fetch"

//when a deadline runs out, in local time: a plain date is due by the end of that day
function deadlineMs(deadline: string): number {
    return deadline.includes("T") ? new Date(`${deadline}:00`).getTime() : new Date(`${deadline}T23:59:59`).getTime()
}

const DUE_SOON_MS = 3 * 24 * 60 * 60 * 1000

//overdue first, then the soonest deadline, then notes without one (unfinished before finished)
function sortNotes(notes: TaskNote[]): TaskNote[] {
    const finished = (n: TaskNote) => n.items.length > 0 && n.items.every(i => i.done)
    return [...notes].sort((a, b) =>
        Number(b.overdue) - Number(a.overdue)
        || Number(finished(a)) - Number(finished(b))
        || (a.deadline ? deadlineMs(a.deadline) : Infinity) - (b.deadline ? deadlineMs(b.deadline) : Infinity)
        || a.task.localeCompare(b.task))
}

//the top of a BESA's dashboard: the tasks the BESA Leads assigned them (Assign Tasks) and the leads' notes on
//them, with deadlines, so they can see what they have to do without going to Profile. Checkboxes tick from here
//too, but only ones ticked while clocked in count toward that day's grade.
export default function MyTasks({assignedTasks}: {assignedTasks: string[]}): JSX.Element | null {
    const [notes, setNotes] = useState<TaskNote[] | null>(null)
    const [failed, setFailed] = useState(false)
    //when the notes loaded - "due soon" is measured from then
    const [loadedAt, setLoadedAt] = useState(0)

    useEffect(() => {
        checkAutoClockout().then(result => {
            if (result?.success) {
                setNotes(result.taskNotes || [])
                setLoadedAt(Date.now())
            } else {
                setFailed(true)
            }
        })
    }, [])

    const withoutNote = assignedTasks.filter(t => !(notes || []).some(n => n.task === t))
    if (notes !== null && notes.length === 0 && assignedTasks.length === 0) return null

    const overdue = (notes || []).filter(n => n.overdue).length
    const dueSoon = (notes || []).filter(n => !n.overdue && n.deadline && !n.items.every(i => i.done)
        && deadlineMs(n.deadline) - loadedAt <= DUE_SOON_MS).length

    return (
        <section id="my-tasks" className="scroll-mt-24 mb-8 bg-be-navy rounded-2xl p-4 sm:p-6 border-l-4 border-be-orange shadow-md">
            <div className="flex flex-wrap items-center gap-2 mb-1">
                <FaClipboardList className="text-be-orange"/>
                <h2 className="text-xl sm:text-2xl font-bold tracking-wide">My Tasks</h2>
                {overdue > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/70 text-red-200">{overdue} overdue</span>}
                {dueSoon > 0 && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/70 text-amber-200">{dueSoon} due soon</span>}
            </div>
            <p className="text-sm text-be-light-gray mb-4">
                What the BESA Leads want you working on. Check things off as you finish them - tick them at the kiosk while
                you're clocked in so they count toward that day's grade.
            </p>

            {notes === null && !failed && <div className="flex justify-center py-4"><MoonLoader color="white" size={20}/></div>}
            {failed && <p className="text-sm text-red-400">Couldn't load your task notes - try refreshing.</p>}

            {notes !== null &&
                <div className="flex flex-col gap-2">
                    {sortNotes(notes).map(note => (
                        <TaskNoteCard key={note.task} note={note}
                            defaultOpen={note.overdue || !note.items.every(i => i.done)}
                            onToggle={async (itemId, done) => {
                                const result = await checkTaskNoteItem(note.task, itemId, done)
                                if (result.success && result.taskNotes) setNotes(result.taskNotes)
                                return result.success ? null : result.detail || "Couldn't save that."
                            }}/>
                    ))}
                    {withoutNote.length > 0 &&
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                            <span className="text-xs text-be-light-gray">{notes.length > 0 ? "Also assigned:" : "Assigned to you:"}</span>
                            {withoutNote.map(task => (
                                <span key={task} className="text-xs px-2.5 py-1 rounded-full bg-be-navy-darker text-white">{task}</span>
                            ))}
                        </div>
                    }
                    {notes.length === 0 && withoutNote.length === 0 &&
                        <p className="text-sm text-be-light-gray italic">No tasks yet.</p>
                    }
                </div>
            }
            <Link to="/profile" className="inline-block mt-4 text-xs text-be-yellow hover:underline">See your hours and grades on Profile</Link>
        </section>
    )
}
