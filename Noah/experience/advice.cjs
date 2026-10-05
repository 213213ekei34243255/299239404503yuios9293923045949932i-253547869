// Noah/experience/advice.cjs
//
// THE ONLY TEXT that experience can ever put into a prompt. Each entry is "<area>:<failure code>" -> one general sentence, written here by hand.
// What Noah remembers about a user is a COUNT of how often one of these known slips happened to them on this computer; it never remembers what was
// typed, read, clicked, searched, said or opened. So nothing a user (or a web page, or a message from a contact) wrote can reach the store, the
// prompt, another session or another account: an unknown code is dropped, and the advice text comes from this table and from nowhere else.
//
// Areas: "computer" (the desktop agent, Windows and Mac), "web" (the browser agent), "project" (a job on the user's own project: outcomes only), "user" (how the user reacts: corrections and stops;
// their lessons go into every prompt).
"use strict";

const ADVICE = Object.freeze({
  // ---- the computer agent
  "computer:text_not_found": "Clicking by words missed: read the window first (desktop_read) and click by element id, or try a shorter, unique word.",
  "computer:ambiguous": "When more than one thing matches, say which with nth or use the element id: never guess.",
  "computer:no_window": "Windows come and go: call desktop_windows first and use the window number it gives, not a guessed title.",
  "computer:stale": "Element ids go stale after any change: read the window again before acting on it.",
  "computer:not_foreground": "Bring the window to the front (desktop_focus) before typing or pressing keys.",
  "computer:user_busy": "The user touched the computer while Noah was working: wait a moment, then carry on instead of repeating at once.",
  "computer:covered": "Something was on top of the spot: take a fresh screenshot before clicking a spot.",
  "computer:outside_window": "The spot was outside the window: use pixels of the screenshot itself ((0,0) is its top-left corner).",
  "computer:timeout": "Waiting for a window by its title failed: titles change (a page's title is not its program's name), so name part of the program or look at desktop_windows.",
  "computer:not_found": "Waiting for a window by its title failed: titles change (a page's title is not its program's name), so name part of the program or look at desktop_windows.",
  "computer:repeat_blocked": "An app that is already open does not need starting again: use its window, or tell the user what you see.",
  "computer:user_denied": "This user has declined actions before: prefer a safer way, and explain or offer an alternative instead of asking for the same thing again.",
  "computer:policy_denied": "Some windows (terminals, password managers, security screens) are off-limits: do not look for a way round it.",
  "computer:password_field": "Never type into a password field: ask the user to type it themselves.",
  "computer:no_such_app": "Check the exact name of the app in the list of installed apps before launching it.",
  "computer:not_invokable": "That control cannot be pressed directly: click it with the mouse method instead.",
  "computer:not_settable": "That field cannot be set directly: click it, then type.",
  "computer:accessibility_denied": "A Mac permission is missing or out of date: tell the user which one, once, and stop trying other ways.",
  "computer:accessibility_stale": "A Mac permission is missing or out of date: tell the user which one, once, and stop trying other ways.",
  "computer:screen_recording_denied": "A Mac permission is missing or out of date: tell the user which one, once, and stop trying other ways.",
  "computer:automation_denied": "A Mac permission is missing or out of date: tell the user which one, once, and stop trying other ways.",
  "computer:focus_failed": "The window could not be brought forward: ask the user to click it, then carry on.",
  "computer:input_blocked": "That program may run as administrator and block input: tell the user instead of retrying.",
  "computer:no_screenshot": "Take a screenshot of that window before clicking by pixels.",
  "computer:screenshot_failed": "Take a screenshot of that window before clicking by pixels.",
  // ---- the user's own reactions (counted from how they react, never from what they say)
  "user:corrected": "This user often corrects the first reading of a request: re-read their exact words before you plan, make your success check match them, and say in the final answer what you understood you were asked to do.",
  "user:stopped": "This user often stops tasks before they finish: work in small, visible steps and report what you have done so far rather than going quiet for a long time.",
  // ---- the web agent
  "web:not_found": "The page changed under the plan: observe again before acting, because references go stale.",
  "web:no_target": "The page changed under the plan: observe again before acting, because references go stale.",
  "web:bad_target": "The page changed under the plan: observe again before acting, because references go stale.",
  "web:no_frame": "The page changed under the plan: observe again before acting, because references go stale.",
  "web:stale_frame": "The page changed under the plan: observe again before acting, because references go stale.",
  "web:obscured": "The target was covered or off screen: close pop-ups and cookie banners, or scroll it into view, first.",
  "web:offscreen": "The target was covered or off screen: close pop-ups and cookie banners, or scroll it into view, first.",
  "web:out_of_range": "A coordinate was outside the page: use a reference from the page, not guessed numbers.",
  "web:ambiguous": "More than one element matched: choose by its visible label or its position.",
  "web:no_effect": "After a click, check that the page really changed; if it did not, try the keyboard or another element.",
});

const AREAS = Object.freeze(["computer", "web", "project", "user"]);
const KEYS = new Set(Object.keys(ADVICE));
const isKnown = (area, code) => typeof area === "string" && typeof code === "string" && KEYS.has(`${area}:${code}`);

module.exports = { ADVICE, AREAS, isKnown };
