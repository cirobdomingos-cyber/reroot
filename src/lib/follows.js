// Which catalog accounts a user follows.
//
// Opt-out: by default you follow every tracked account, and state keeps
// only the handles you turned off (`state.unfollowedSources`, lowercase,
// synced with the rest of the user state). That keeps the default feed
// intact for everyone who never opens Fontes, and a newly tracked account
// shows up for you without doing anything.
//
// Only Instagram catalog events are filtered. Private events (groups,
// plans) and the editorial auê Originals are never hidden.

export function unfollowedSet(state) {
  return new Set((state?.unfollowedSources || []).map(h => String(h).toLowerCase()))
}

export function hiddenByFollows(ev, hidden) {
  return !!(hidden.size && !ev.isGroupEvent && ev.igHandle && hidden.has(ev.igHandle.toLowerCase()))
}
