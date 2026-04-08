export const FRAMEWORK = {
  week: 3,
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
}

export const TIMELINE = [
  { week: 1, label: 'Week 1', event: 'Orientation & First Framework', note: 'Completed "The Ground Beneath You"', state: 'done' },
  { week: 2, label: 'Week 2', event: 'First Event Attended 🎉',        note: 'Sunday Coffee Walk · Earned "Said Yes" badge', state: 'done' },
  { week: 3, label: 'Week 3 · Current', event: 'The Re-entry Ritual',  note: '2 events prescribed', state: 'current' },
  { week: 6, label: 'Week 6 · Milestone', event: 'Cohort Gathering',   note: 'In-person meetup for all cohort members', state: 'locked' },
  { week: 12, label: 'Week 12 · Graduation', event: 'Roots Established 🌱', note: 'Complete your recovery arc', state: 'locked' },
]
