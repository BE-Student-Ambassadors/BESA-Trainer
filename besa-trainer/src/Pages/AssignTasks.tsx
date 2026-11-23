import { useEffect, useState } from "react"
import { MoonLoader } from "react-spinners"
import { FaCheck, FaPlus, FaRegBell, FaRegStickyNote, FaTrash } from "react-icons/fa"
import { formatDeadline } from "../Tools/taskNotes"
import Header from "../Components/Header"
import TaskNoteCard from "../Components/TaskNoteCard"
import { addActivityType, assignTasks, getActivityTypes, getBesaAccounts, remindTask, setTaskNote, type BesaAccount, type TaskNote, type TaskPriority } from "../Tools/Fetch"

const TASK_NAME_MAX_LENGTH = 40 // same cap as the backend's TASK_NAME_MAX_LENGTH
//same caps as the backend's TASK_NOTE_* limits
const NOTE_DESCRIPTION_MAX_LENGTH = 1000
const NOTE_ITEM_MAX_LENGTH = 200
const NOTE_MAX_ITEMS = 20

//BESA Lead only (gated by RequireAccess in App.tsx) - picks which activities each BESA and BESA Lead (leads
//included, themselves too) should work on. The kiosk's Clock In offers only someone's assigned tasks
//(as "Lead recommended") plus Other for anything else. Clock-out still offers every activity.
//Each assigned task can also carry a note for that person - a description plus checkboxes they tick off - which
//shows at the kiosk when they pick that task to clock in, in Current Sessions, and on their Profile.
export default function AssignTasks() {
    const [accounts, setAccounts] = useState<BesaAccount[] | null>(null)
    const [tasks, setTasks] = useState<string[] | null>(null)
    const [savingUids, setSavingUids] = useState<string[]>([])
    const [search, setSearch] = useState("")
    const [newTask, setNewTask] = useState("")
    const [addingTask, setAddingTask] = useState(false)
    const [bulkTask, setBulkTask] = useState<string | null>(null)
    const [error, setError] = useState("")

    useEffect(() => {
        getBesaAccounts().then(result => setAccounts(result || []))
        getActivityTypes().then(result => setTasks(result || []))
    }, [])

    async function save(account: BesaAccount, wanted: string[]): Promise<boolean> {
        //a task removed from the list at the kiosk would be refused, so it's dropped here
        const next = wanted.filter(t => tasks?.includes(t))
        setSavingUids(prev => [...prev, account.uid])
        const result = await assignTasks(account.uid, next)
        setSavingUids(prev => prev.filter(uid => uid !== account.uid))
        if (result.success) {
            setAccounts(prev => prev && prev.map(a => a.uid === account.uid ? {...a, assignedTasks: result.assignedTasks || next} : a))
            return true
        }
        setError(`Couldn't update ${account.besaName || "that account"}: ${result.detail || "something went wrong."}`)
        return false
    }

    function toggle(account: BesaAccount, task: string) {
        setError("")
        const has = account.assignedTasks.includes(task)
        void save(account, has ? account.assignedTasks.filter(t => t !== task) : [...account.assignedTasks, task])
    }

    //hands one task to everyone who doesn't have it yet - handy for something everybody does (e.g. Tours)
    async function giveEveryone(task: string) {
        if (!accounts) return
        const missing = accounts.filter(a => !a.assignedTasks.includes(task))
        if (missing.length === 0 || !window.confirm(`Assign "${task}" to ${missing.length === 1 ? "1 more person" : `${missing.length} more people`}?`)) return
        setError("")
        setBulkTask(task)
        await Promise.all(missing.map(a => save(a, [...a.assignedTasks, task])))
        setBulkTask(null)
    }

    async function handleAddTask() {
        const name = newTask.trim()
        if (!name) return
        setAddingTask(true)
        setError("")
        const result = await addActivityType(name)
        setAddingTask(false)
        if (result) {
            setTasks(result)
            setNewTask("")
        } else {
            setError("Couldn't add that task. Please try again.")
        }
    }

    //leads first (they have to give themselves tasks too), then by name
    const shown = (accounts || [])
        .filter(a => (a.besaName || "").toLowerCase().includes(search.trim().toLowerCase()))
        .sort((a, b) => Number(b.accountType === "besaLead") - Number(a.accountType === "besaLead") || (a.besaName || "").localeCompare(b.besaName || ""))
    const unassigned = (accounts || []).filter(a => a.assignedTasks.filter(t => tasks?.includes(t)).length === 0)

    return (
        <div className="bg-gray-900 w-full min-h-screen text-white">
            <Header/>
            <div className="h-16 relative top-0 left-0 w-full"></div>
            <div className="w-11/12 md:w-5/6 max-w-5xl mx-auto py-10">
                <h1 className="text-2xl sm:text-3xl md:text-4xl tracking-wider mb-1">Assign Tasks</h1>
                <p className="text-gray-400 text-sm mb-6">
                    Choose what each BESA should work on - at the kiosk's Clock In, the tasks assigned to someone here are highlighted as
                    "Lead recommended", and those are the only tasks they can pick there (anything else goes under Other). BESA Leads can have tasks too, including your own.
                    To set a priority or deadline, open a task's note under someone's name - a deadline needs checkboxes, plus a date
                    (and a time, if you want). People are emailed about a task when it's assigned to them or its priority or deadline
                    changes, a few minutes after your last edit, so several changes go out as one email. Remind sends them an
                    email about that task straight away, with its due date.
                </p>

                {accounts === null || tasks === null ?
                    <div className="flex justify-center py-20"><MoonLoader color="white" size={30}/></div>
                    :
                    <div className="flex flex-col gap-6">
                        {unassigned.length > 0 &&
                            <div className="rounded-xl bg-amber-900/40 border border-amber-600 p-3 text-sm text-amber-100">
                                <span className="font-semibold">{unassigned.length === 1 ? "1 person has" : `${unassigned.length} people have`} no recommended tasks yet:</span>{" "}
                                {unassigned.map(a => a.besaName || "(no name on file)").join(", ")}
                            </div>
                        }

                        <section className="bg-gray-800 rounded-2xl p-4 sm:p-6">
                            <h2 className="text-xl tracking-wide mb-1">Tasks</h2>
                            <p className="text-sm text-gray-400 mb-3">Tap a task to give it to everyone who doesn't have it yet. New tasks are added to the kiosk's activity list.</p>
                            <div className="flex flex-wrap gap-2 mb-4">
                                {tasks.map(task => {
                                    const count = accounts.filter(a => a.assignedTasks.includes(task)).length
                                    return (
                                        <button key={task} onClick={() => void giveEveryone(task)} disabled={bulkTask !== null}
                                            title={`${count} of ${accounts.length} assigned - tap to give it to everyone`}
                                            className="px-3 py-1.5 rounded-full text-sm bg-gray-700 hover:bg-gray-600 disabled:opacity-50 flex items-center gap-2">
                                            {bulkTask === task && <MoonLoader color="white" size={12}/>}
                                            {task}
                                            <span className="text-xs text-gray-400 tabular-nums">{count}/{accounts.length}</span>
                                        </button>
                                    )
                                })}
                            </div>
                            <div className="flex gap-2">
                                <input value={newTask} maxLength={TASK_NAME_MAX_LENGTH} disabled={addingTask}
                                    onChange={(e) => setNewTask(e.target.value)}
                                    onKeyDown={(e) => { if (e.key === "Enter") void handleAddTask() }}
                                    placeholder="New task name"
                                    className="flex-1 min-w-0 p-2 px-3 rounded-xl bg-gray-700 text-white"/>
                                <button onClick={() => void handleAddTask()} disabled={addingTask || !newTask.trim() || tasks.includes(newTask.trim())}
                                    className="px-4 rounded-full bg-blue-800 hover:bg-blue-900 disabled:opacity-40 flex items-center gap-2 text-sm">
                                    {addingTask ? <MoonLoader color="white" size={14}/> : <FaPlus size={11}/>}
                                    Add Task
                                </button>
                            </div>
                        </section>

                        {error && <p className="text-red-400 text-sm">{error}</p>}

                        <section className="flex flex-col gap-3">
                            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name"
                                className="w-full sm:w-72 p-2 px-3 rounded-xl bg-gray-800 border border-gray-700 text-white"/>
                            {shown.length === 0 ?
                                <p className="text-gray-500 italic text-sm">{accounts.length === 0 ? "No BESA accounts yet." : "Nobody matches that name."}</p>
                                : shown.map(account => {
                                    const saving = savingUids.includes(account.uid)
                                    const assigned = account.assignedTasks.filter(t => tasks.includes(t))
                                    return (
                                        <div key={account.uid} className={"bg-gray-800 rounded-2xl p-4 border " + (assigned.length === 0 ? "border-amber-600/70" : "border-transparent")}>
                                            <div className="flex items-center gap-2 mb-3 flex-wrap">
                                                <p className="font-semibold">{account.besaName || "(no name on file)"}</p>
                                                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-300">
                                                    {account.accountType === "besaLead" ? "BESA Lead" : "BESA"}
                                                </span>
                                                <span className="text-xs text-gray-400">
                                                    {assigned.length === 0 ? "No recommended tasks" : `${assigned.length} task${assigned.length === 1 ? "" : "s"}`}
                                                </span>
                                                {saving && <MoonLoader color="white" size={14}/>}
                                                {assigned.length > 0 &&
                                                    <div className="ml-auto"><RemindButton account={account} tasks={assigned}/></div>
                                                }
                                            </div>
                                            <div className="flex flex-wrap gap-2 mb-3">
                                                {tasks.map(task => {
                                                    const selected = assigned.includes(task)
                                                    return (
                                                        <button key={task} type="button" disabled={saving} aria-pressed={selected}
                                                            onClick={() => toggle(account, task)}
                                                            className={"px-3 py-1.5 rounded-full text-sm font-semibold disabled:opacity-60 " +
                                                                (selected ? "bg-amber-500 text-black" : "bg-gray-700 text-gray-200 hover:bg-gray-600")}>
                                                            {task}
                                                        </button>
                                                    )
                                                })}
                                            </div>
                                            {assigned.length > 0 &&
                                                <MemberTaskNotes account={account} tasks={assigned}
                                                    onSaved={(taskNotes) => setAccounts(prev => prev && prev.map(a => a.uid === account.uid ? {...a, taskNotes} : a))}/>
                                            }
                                        </div>
                                    )
                                })
                            }
                        </section>
                    </div>
                }
            </div>
        </div>
    )
}

//one person's notes on their assigned tasks - each shown as it'll appear to them, with Edit; tasks with no note
//get an "add note" button
function MemberTaskNotes({account, tasks, onSaved}: {account: BesaAccount, tasks: string[], onSaved: (notes: TaskNote[]) => void}) {
    const [editing, setEditing] = useState<string | null>(null)
    const withoutNote = tasks.filter(t => !account.taskNotes.some(n => n.task === t))

    return (
        <div className="flex flex-col gap-2">
            {tasks.map(task => {
                const note = account.taskNotes.find(n => n.task === task)
                if (editing === task) {
                    return <TaskNoteEditor key={task} account={account} task={task} note={note}
                        onDone={(notes) => { if (notes) onSaved(notes); setEditing(null) }}/>
                }
                if (!note) return null
                return (
                    <div key={task} className="flex items-start gap-2">
                        <div className="flex-1 min-w-0"><TaskNoteCard note={note}/></div>
                        <div className="flex flex-col sm:flex-row items-stretch gap-2 shrink-0">
                            <button onClick={() => setEditing(task)} disabled={editing !== null}
                                className="text-xs px-3 py-2 rounded-full bg-gray-700 hover:bg-gray-600 disabled:opacity-40">
                                {note.deadline && note.priority ? "Edit" : "Edit / Set Priority & Deadline"}
                            </button>
                            <RemindButton account={account} task={task} note={note}/>
                        </div>
                    </div>
                )
            })}
            {/* tasks with no note yet - add one (for a priority or deadline), or remind them about the task as it is */}
            {withoutNote.filter(task => task !== editing).map(task => (
                <div key={task} className="flex items-center gap-2 rounded-lg border border-dashed border-gray-600 px-3 py-1.5 text-sm">
                    <span className="font-semibold text-gray-200">{task}</span>
                    <span className="text-xs text-gray-500">No note, priority or deadline</span>
                    <div className="ml-auto flex flex-col sm:flex-row items-stretch gap-2 shrink-0">
                        <button onClick={() => setEditing(task)} disabled={editing !== null}
                            className="flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-full bg-gray-700 hover:bg-gray-600 disabled:opacity-40">
                            <FaRegStickyNote size={10}/> Add note
                        </button>
                        <RemindButton account={account} task={task}/>
                    </div>
                </div>
            ))}
        </div>
    )
}

//emails the person right now about one task (`task`, with its note if it has one), or - given `tasks` instead -
//about every task they're assigned in one email, soonest due first. Says "Reminder sent" after.
function RemindButton({account, task, note, tasks}: {account: BesaAccount, task?: string, note?: TaskNote, tasks?: string[]}) {
    const [state, setState] = useState<"idle" | "sending" | "sent">("idle")
    const [error, setError] = useState("")
    const name = account.besaName || "this person"

    async function remind() {
        const question = task
            ? `Email ${name} a reminder about ${task}${note?.deadline ? ` with its due date (${formatDeadline(note.deadline)})` : " (it has no due date)"}?`
            : `Email ${name} one reminder about all ${tasks?.length || 0} of their tasks, with their due dates?`
        if (!window.confirm(question)) return
        setState("sending")
        setError("")
        const result = await remindTask(account.uid, task)
        if (result.success) {
            setState("sent")
        } else {
            setState("idle")
            setError(result.detail || "Couldn't send the reminder.")
        }
    }

    return (
        <div className="flex flex-col items-stretch">
            <button onClick={() => void remind()} disabled={state !== "idle"} title={task ? `Email ${name} about ${task} now` : `Email ${name} about all their tasks now`}
                className={"text-xs px-3 py-2 rounded-full flex items-center justify-center gap-1.5 disabled:cursor-default " +
                    (state === "sent" ? "bg-green-900/60 text-green-300" : "bg-blue-800 hover:bg-blue-900 disabled:opacity-60")}>
                {state === "sending" ? <MoonLoader color="white" size={10}/> : state === "sent" ? <FaCheck size={10}/> : <FaRegBell size={10}/>}
                {state === "sent" ? "Reminder sent" : task ? "Remind" : "Remind about all"}
            </button>
            {error && <p className="text-red-400 text-[11px] mt-1 max-w-40">{error}</p>}
        </div>
    )
}

//today as "YYYY-MM-DD" in local time (the earliest deadline a lead can pick)
function todayIso(): string {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

//writes one note: a description and any number of checkboxes. Saving it empty removes the note. Checkboxes keep
//their ids, so ones the person already ticked stay ticked.
function TaskNoteEditor({account, task, note, onDone}: {
    account: BesaAccount, task: string, note?: TaskNote, onDone: (notes: TaskNote[] | null) => void
}) {
    const [description, setDescription] = useState(note?.description || "")
    const [items, setItems] = useState<{key: number, id?: string, text: string, done: boolean}[]>(
        () => (note?.items || []).map((i, k) => ({key: k, id: i.id, text: i.text, done: i.done})))
    const [nextKey, setNextKey] = useState(items.length)
    //the deadline is "YYYY-MM-DD" (end of that day) or "YYYY-MM-DDTHH:MM", both Pacific - edited as a date and an optional time
    const [deadlineDate, setDeadlineDate] = useState(note?.deadline?.split("T")[0] || "")
    const [deadlineTime, setDeadlineTime] = useState(note?.deadline?.split("T")[1] || "")
    const deadline = deadlineDate ? (deadlineTime ? `${deadlineDate}T${deadlineTime}` : deadlineDate) : ""
    const [priority, setPriority] = useState<TaskPriority>(note?.priority || "medium")
    const [busy, setBusy] = useState(false)
    const hasItems = items.some(i => i.text.trim())
    const [error, setError] = useState("")

    function clearDeadline() {
        setDeadlineDate("")
        setDeadlineTime("")
    }

    async function save(remove = false) {
        setBusy(true)
        setError("")
        const result = await setTaskNote(account.uid, task, remove ? "" : description,
            remove ? [] : items.filter(i => i.text.trim()).map(i => ({id: i.id, text: i.text})),
            remove || !items.some(i => i.text.trim()) ? null : deadline || null, remove ? null : priority)
        setBusy(false)
        if (result.success) onDone(result.taskNotes || [])
        else setError(result.detail || "Couldn't save the note.")
    }

    return (
        <div className="rounded-lg border border-amber-500/60 bg-gray-900/50 p-3 flex flex-col gap-2 text-sm">
            <p className="font-semibold text-amber-200">Note on {task} for {account.besaName || "this person"}</p>
            <textarea value={description} maxLength={NOTE_DESCRIPTION_MAX_LENGTH} rows={3} disabled={busy} autoFocus
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What should they know or focus on next time?"
                className="w-full p-2 rounded-lg bg-gray-700 text-white"/>
            <p className="text-xs text-gray-400">Checkboxes (optional) - they tick these off, and you can see their progress here.</p>
            {items.map(item => (
                <div key={item.key} className="flex items-center gap-2">
                    <input type="checkbox" checked={item.done} disabled aria-label={item.done ? "Done" : "Not done yet"}
                        className="w-4 h-4 accent-amber-500 shrink-0"/>
                    <input value={item.text} maxLength={NOTE_ITEM_MAX_LENGTH} disabled={busy}
                        onChange={(e) => setItems(items.map(i => i.key === item.key ? {...i, text: e.target.value} : i))}
                        placeholder="Something to do"
                        className="flex-1 min-w-0 p-1.5 px-2 rounded-lg bg-gray-700 text-white"/>
                    <button onClick={() => setItems(items.filter(i => i.key !== item.key))} disabled={busy} aria-label="Remove checkbox"
                        className="p-2 rounded-full bg-gray-700 hover:bg-red-800 disabled:opacity-40">
                        <FaTrash size={10}/>
                    </button>
                </div>
            ))}
            {items.length < NOTE_MAX_ITEMS &&
                <button onClick={() => { setItems([...items, {key: nextKey, text: "", done: false}]); setNextKey(nextKey + 1) }} disabled={busy}
                    className="self-start flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-gray-700 hover:bg-gray-600 disabled:opacity-40">
                    <FaPlus size={9}/> Add checkbox
                </button>
            }
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-gray-300">Priority</span>
                {(["high", "medium", "low"] as const).map(level => (
                    <button key={level} type="button" onClick={() => setPriority(level)} disabled={busy} aria-pressed={priority === level}
                        className={"text-xs px-3 py-1 rounded-full font-semibold disabled:opacity-40 " +
                            (priority === level ? (level === "high" ? "bg-orange-600 text-black" : level === "medium" ? "bg-amber-500 text-black" : "bg-gray-300 text-black")
                                : "bg-gray-700 text-gray-300 hover:bg-gray-600")}>
                        {level[0].toUpperCase() + level.slice(1)}
                    </button>
                ))}
            </div>
            {/* always shown so leads can find it - a deadline needs something to finish, so it unlocks once there's a checkbox */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-gray-800/70 p-2">
                <label htmlFor={`deadline-${task}`} className="text-xs font-semibold text-gray-300">Deadline (optional)</label>
                <input id={`deadline-${task}`} type="date" value={hasItems ? deadlineDate : ""} disabled={busy || !hasItems}
                    min={note?.deadline && note.deadline.split("T")[0] === deadlineDate ? undefined : todayIso()}
                    onChange={(e) => { setDeadlineDate(e.target.value); if (!e.target.value) setDeadlineTime("") }}
                    className="p-1.5 px-2 rounded-lg bg-gray-700 text-white text-xs [color-scheme:dark] disabled:opacity-40"/>
                <label htmlFor={`deadline-time-${task}`} className="text-xs text-gray-400">Time (optional)</label>
                <input id={`deadline-time-${task}`} type="time" value={hasItems ? deadlineTime : ""} disabled={busy || !hasItems || !deadlineDate}
                    onChange={(e) => setDeadlineTime(e.target.value)}
                    className="p-1.5 px-2 rounded-lg bg-gray-700 text-white text-xs [color-scheme:dark] disabled:opacity-40"/>
                {deadlineDate && hasItems &&
                    <button onClick={clearDeadline} disabled={busy} className="text-xs text-gray-400 hover:text-white underline">Clear</button>
                }
                <p className="w-full text-xs text-gray-500">
                    {!hasItems ? "Add a checkbox first - the deadline is for getting the checkboxes done."
                        : `Due by ${deadlineTime ? "that time (Pacific)" : "the end of that day"}. If the checkboxes aren't all ticked by then, ${account.besaName || "they"} and the root account get an email.`}
                </p>
            </div>
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <div className="flex flex-wrap gap-2 mt-1">
                <button onClick={() => void save()} disabled={busy || (!description.trim() && !items.some(i => i.text.trim()))}
                    className="px-4 py-1.5 rounded-full bg-blue-800 hover:bg-blue-900 disabled:opacity-40 flex items-center gap-2">
                    {busy && <MoonLoader color="white" size={12}/>}
                    Save Note
                </button>
                <button onClick={() => onDone(null)} disabled={busy}
                    className="px-4 py-1.5 rounded-full border border-gray-500 hover:bg-gray-700 disabled:opacity-40">
                    Cancel
                </button>
                {note &&
                    <button onClick={() => { if (window.confirm(`Remove the note on ${task}?`)) void save(true) }} disabled={busy}
                        className="ml-auto px-4 py-1.5 rounded-full bg-red-800 hover:bg-red-900 disabled:opacity-40">
                        Remove Note
                    </button>
                }
            </div>
        </div>
    )
}
