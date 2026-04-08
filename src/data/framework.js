// ── Multi-week framework library ───────────────────────────
// Each week has: title, subtitle, methodology, prompts, reframes, actions, note
// Journey.jsx uses getFramework(currentWeek) to render the right one.

export const FRAMEWORKS = {
  1: {
    title: 'The Ground Beneath You',
    subtitle: 'Before showing up for others, you need to know where you\'re standing. This week is about orientation — not performance.',
    methodology: 'AI-generated with therapist-reviewed methodology · Not a substitute for therapy',
    prompts: [
      {
        num: '01',
        question: 'What does your ideal social life look like in 12 weeks — not perfect, just better than now?',
        hint: 'Be specific. One person, one setting, one feeling.',
      },
      {
        num: '02',
        question: 'When did you last feel genuinely comfortable around other people? What made that possible?',
        hint: 'The conditions matter more than the event.',
      },
      {
        num: '03',
        question: 'What\'s the one social situation you\'ve been avoiding the longest?',
        hint: 'Name it. You don\'t have to face it this week — just name it.',
      },
    ],
    reframes: [
      {
        label: 'Reframe 01 — The Starting Line',
        from: '"I\'m so far behind. Everyone else has this figured out."',
        to: '"Everyone starts somewhere. My somewhere is here, this week."',
      },
      {
        label: 'Reframe 02 — The Pressure Trap',
        from: '"I need to be social all the time to get better."',
        to: '"One small interaction per week moves the needle. That\'s enough."',
      },
    ],
    actions: [
      { step: 1, text: '**Read your cohort intro** and notice one person whose situation sounds familiar.' },
      { step: 2, text: '**Attend one event** from your list — even if you leave early. Arriving counts.' },
      { step: 3, text: '**Write three sentences** about how you felt before, during, and after.' },
    ],
    note: 'Week 1 is not about results — it\'s about **showing your nervous system that nothing catastrophic happens** when you show up. Repetition builds safety. Safety builds connection.',
  },

  2: {
    title: 'The First Yes',
    subtitle: 'Saying yes is harder than it looks. This week is about the gap between "I should go" and "I\'m going."',
    methodology: 'AI-generated with therapist-reviewed methodology · Not a substitute for therapy',
    prompts: [
      {
        num: '01',
        question: 'What happened in your body the last time you said yes to something social and it went okay?',
        hint: 'Notice the physical memory — shoulders, chest, breath.',
      },
      {
        num: '02',
        question: 'What\'s your most common exit strategy, and what does it protect you from?',
        hint: 'There\'s no judgment here. Exit strategies exist for a reason.',
      },
      {
        num: '03',
        question: 'If a close friend described your social self at your best, what would they say?',
        hint: 'This version of you still exists. We\'re just rebuilding access.',
      },
    ],
    reframes: [
      {
        label: 'Reframe 01 — The Decision Window',
        from: '"I\'ll decide if I feel like going on the day."',
        to: '"I decide now. Feelings are consulted, not in charge."',
      },
      {
        label: 'Reframe 02 — The Good Enough Bar',
        from: '"If it\'s not a great event, it wasn\'t worth going."',
        to: '"Neutral is a win. Slightly uncomfortable means growth."',
      },
    ],
    actions: [
      { step: 1, text: '**RSVP to one event** before Friday — committing in advance changes the calculus.' },
      { step: 2, text: '**Set a minimum**: you only need to stay 20 minutes. Let yourself exceed that.' },
      { step: 3, text: '**Text one person** in your cohort after the event. One line is enough.' },
    ],
    note: 'The research on social anxiety consistently shows that **avoidance maintains fear**. You don\'t wait to feel brave — you act, and bravery follows. This week\'s single job: one yes.',
  },

  3: {
    title: 'The Re-entry Ritual',
    subtitle: 'A structured guide for showing up socially after a long pause — without pressure, performance, or pretending.',
    methodology: 'AI-generated with therapist-reviewed methodology · Not a substitute for therapy',
    prompts: [
      {
        num: '01',
        question: 'What does "showing up" mean to you right now — and how is that different from what it meant two years ago?',
        hint: 'Take 5 minutes. Write freely. Don\'t edit.',
      },
      {
        num: '02',
        question: 'Name one small moment from this week where you felt genuinely yourself — even briefly.',
        hint: 'It doesn\'t have to be social. A walk counts.',
      },
      {
        num: '03',
        question: 'What\'s the specific story you tell yourself before you decline an invitation?',
        hint: 'Naming the story is the first step to changing it.',
      },
    ],
    reframes: [
      {
        label: 'Reframe 01 — The Expectation Trap',
        from: '"I need to be interesting / funny / \'on\' when I go out."',
        to: '"My only job is to show up. The rest is optional."',
      },
      {
        label: 'Reframe 02 — The Energy Myth',
        from: '"I\'ll go when I feel ready / have more energy."',
        to: '"Energy follows action, not the other way around. Small steps first."',
      },
    ],
    actions: [
      { step: 1, text: 'Attend **one event** from your prescription. Not two. One.' },
      { step: 2, text: '**Say your name first** to one person you haven\'t met. That\'s the whole goal.' },
      { step: 3, text: '**Journal for 5 minutes** after the event. Not what happened — how you felt walking in.' },
    ],
    note: 'Research on social re-entry consistently shows the threshold moment is **walking through the door** — not how the event goes. Your nervous system needs repetition, not perfection.',
  },
}

// Returns the framework for the given week, falling back to week 3 if not yet written
export function getFramework(week) {
  return FRAMEWORKS[week] ?? FRAMEWORKS[3]
}

// ── Journey timeline ───────────────────────────────────────
// States are computed dynamically in Profile.jsx based on currentWeek
export const TIMELINE = [
  { week: 1,  label: 'Week 1',             event: 'Orientation & First Framework',   note: 'Framework: The Ground Beneath You' },
  { week: 2,  label: 'Week 2',             event: 'First Event',                     note: 'Framework: The First Yes' },
  { week: 3,  label: 'Week 3',             event: 'The Re-entry Ritual',             note: 'Framework: The Re-entry Ritual' },
  { week: 6,  label: 'Week 6 · Milestone', event: 'Cohort Gathering',                note: 'In-person meetup for all cohort members' },
  { week: 12, label: 'Week 12 · Finale',   event: 'Roots Established 🌱',            note: 'Complete your 12-week arc' },
]
