// Noah/autonomy/no-model.cjs - what the user is told when a task needs Jonah's AI model and there is none.
//
// Background (found by a real Mac test): tasks use Jonah's hosted model (Gemini behind noahai.live), which is served ONLY to a signed-in Jonah account; the account is the
// identity every request is signed with. The user's Windows PC had signed in once (the saved session lives on that computer); a fresh Mac had not, and an unlimited build
// (billing off) never asks. The router then fell back to the legacy text backend, which cannot run tasks ("HTTP 400: Missing goal"), and the task paused again and again as "the
// model could not be reached". Now there is no such fallback for tasks, the app opens the one-time Google sign-in itself when the user asks for a task (never mid-task), and
// these messages say what is actually going on.
"use strict";

/** No model and the app cannot start a sign-in (an older shell, or no hosted model configured). */
const NO_MODEL_REPLY =
  "Noah needs you to be signed in to Jonah to use its AI model for tasks, so it did not start. Sign in to your Jonah account, then ask again.";

/** The user asked for a task while not signed in: the browser has just been opened for Google sign-in. */
const SIGN_IN_STARTED_REPLY =
  "Noah needs you signed in to Jonah to use its AI model for tasks (one time only). I have opened your browser: sign in with Google there, then ask me again (or say \"continue\").";

/** A sign-in is already open in the browser. */
const SIGN_IN_WAITING_REPLY =
  "Still waiting for you to finish signing in, in your browser. When it says you are signed in, ask me again (or say \"continue\").";

/** The sign-in finished. */
const SIGNED_IN_REPLY = "You are signed in to Jonah. Ask me again (or say \"continue\") and Noah will start.";

/** Signed in, yet the hosted model is not taking requests (it refused one a moment ago, or is unreachable). */
const SIGNED_IN_NO_MODEL_REPLY =
  "Jonah is signed in, but its AI model is not accepting requests right now. Wait a few minutes and try again.";

/** Said when the Computer agent mode is picked and the computer agent cannot run (no model, or not Windows/macOS). */
const COMPUTER_AGENT_UNAVAILABLE =
  "The computer agent is not available right now. It works on Windows and on macOS (Intel and Apple silicon), and it needs you to be signed in to Jonah (a one-time Google sign-in).";

module.exports = { NO_MODEL_REPLY, SIGN_IN_STARTED_REPLY, SIGN_IN_WAITING_REPLY, SIGNED_IN_REPLY, SIGNED_IN_NO_MODEL_REPLY, COMPUTER_AGENT_UNAVAILABLE };
