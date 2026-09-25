"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { needsGrounding, admitsNotKnowing, formatSearchResults } = require("../../../Rexy/grounding.cjs");

test("needsGrounding: fact lookups a small model invents answers for", () => {
  for (const q of [
    "who is Ironman", "who is ironman", "Who played Iron Man?", "who won the world cup in 2022", "who created Minecraft",
    "when did the Berlin wall fall", "where is Machu Picchu", "how many people live in Tokyo", "how old is Tom Cruise",
    "what year did world war 2 end", "what is Tesla", "what's OpenAI", "what is the weather like in London",
    "latest news about the Mars mission", "what is the price of bitcoin today", "hey can you tell me who is the president of France",
  ]) assert.equal(needsGrounding(q), true, q);
});

test("needsGrounding: chit-chat, opinions, writing, maths, page questions and questions about Noah are NOT searched", () => {
  for (const q of [
    "Good morning", "hey", "how are you doing??", "thanks babe", "thanks", "who are you", "who made you", "what is your name",
    "who created you and Noah", "tell me a joke", "write a poem about the sea", "explain how photosynthesis works",
    "solve 2x + 3 = 7", "what do you think about pineapple on pizza", "what is a black hole", "what is love",
    "summarize this page", "what does this article say", "Good morning. Its a good weather uk chills", "ok",
    "I love this song, it is a good day today",
  ]) assert.equal(needsGrounding(q), false, q);
});

test("needsGrounding: absurd lengths are ignored rather than sent to a search engine", () => {
  assert.equal(needsGrounding(""), false);
  assert.equal(needsGrounding("who is " + "x".repeat(500)), false);
});

test("admitsNotKnowing: the model saying it is unsure or has a cutoff", () => {
  for (const a of [
    "I'm not sure about that.", "I don't know who that is.", "I do not have information about that event.", "As of my last training update, I can't say.",
    "My knowledge cutoff means I can't verify this.", "I am unable to find details on that.", "I don't have access to real-time data.",
    "I apologize, but I do not have access to real-time information and cannot provide current news updates.",
  ]) assert.equal(admitsNotKnowing(a), true, a);
});

test("admitsNotKnowing: a confident answer, an empty one and the server's canned command reply are not admissions", () => {
  for (const a of [
    "Iron Man is played by Robert Downey Jr.", "It was released in 2008.", "", null,
    "I couldn't find a matching command. Try again with clearer words.", "Invalid input",
  ]) assert.equal(admitsNotKnowing(a), false, String(a));
});

test("formatSearchResults: numbered, trimmed, capped at five, tells the model to stick to them, empty when there is nothing", () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ title: ` Title ${i} `, snippet: "line one\n   line two" }));
  const block = formatSearchResults("q", items);
  assert.match(block, /^Web search results for "q":\n1\. Title 0 - line one line two/);
  assert.equal(block.split("\n").length, 7, "header + five results + the stick-to-the-results instruction");
  assert.match(block.split("\n")[6], /^Answer ONLY from the search results above/);
  assert.doesNotMatch(block, /Title 5/, "capped at five");
  assert.equal(formatSearchResults("q", []), "");
});
