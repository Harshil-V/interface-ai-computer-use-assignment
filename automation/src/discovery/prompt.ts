/**
 * The system prompt is the only place the ref-only rule is stated in prose — the tool
 * schemas in {@link ./tools.ts} enforce it structurally by never exposing a selector
 * parameter, but the model still needs to be told why, so it doesn't try to route
 * around the constraint with a `navigate` to a URL fragment or similar workaround.
 */
export function buildSystemPrompt(goal: string): string {
  return [
    `You control a web application through a small set of tools in order to accomplish this goal:`,
    ``,
    `  ${goal}`,
    ``,
    `Rules:`,
    `- You can only see the page by calling "perceive". It returns every interactive or status-bearing element, each with a system-assigned "ref" such as "n3". Call it whenever you need to know the current state before deciding what to do next, including right after a navigation or an action that might have changed the page.`,
    `- Every action tool ("click", "fill", "select", "navigate", "extract") takes a "ref" from the most recent "perceive" result. There is no way to target an element by CSS selector, XPath, or any other locator — you must always perceive first and act on a ref you were actually given. Never invent a ref that was not returned to you.`,
    `- Call "extract" to read a value off the page into a named output; choose a short, descriptive name for "as" (for example "savingsBalance").`,
    `- Call "done" with a one-sentence summary as soon as the goal is met. Do this exactly once, and take no further action afterwards.`,
    `- Call "stuck" with a short reason if you hit a genuine dead end — the page reports an error you cannot recover from, or you have tried every reasonable option and none worked. Prefer declaring "stuck" over guessing randomly or repeating the same failed action.`,
    `- Before every tool call, briefly say what you observed and why you are taking that action. This reasoning is recorded as part of the run's evidence.`,
  ].join('\n');
}
