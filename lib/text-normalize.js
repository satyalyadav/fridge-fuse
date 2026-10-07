"use strict";

// One shared text-flattening helper for food identity. Ingredient text arrives
// from the student, the model, and publisher pages with different punctuation
// and accents, so everything is flattened the same way before it is matched.

function stripAccents(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function flattenText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Ingredient identity without a price catalog: lowercase, collapse punctuation,
// and singularize the common grocery plurals so "eggs" and "egg" are the same
// food. The suffix rules leave mass nouns alone ("asparagus", "hummus", "rice").
function normalizeIngredient(name) {
  const text = flattenText(stripAccents(name));
  if (!text) return "";
  const last = text.split(" ").pop();
  const singular = last === "leaves"
    ? "leaf"
    : last.endsWith("ies") && last.length > 4
    ? `${last.slice(0, -3)}y`
    : last.endsWith("oes") && last.length > 4
      ? last.slice(0, -2)
      : /(?:ss|us|is)$/.test(last)
        ? last
        : last.endsWith("s") ? last.slice(0, -1) : last;
  return last === singular ? text : text.slice(0, text.length - last.length) + singular;
}

function normalizeIngredientOwnership(name, preservedPreparationStates = []) {
  const key = normalizeIngredient(name)
    .replace(/^(?:(?:diced|chopped|sliced|minced|grated|shredded|peeled|cubed)\s+)+/, "")
    .replace(/^broccoli floret$/, "broccoli");
  const paddedKey = ` ${key} `;
  const states = Array.isArray(preservedPreparationStates) ? preservedPreparationStates : [];
  const missingStates = states.filter((state) => !paddedKey.includes(` ${state} `));
  return [...missingStates, key].filter(Boolean).join(" ");
}

module.exports = { stripAccents, flattenText, normalizeIngredient, normalizeIngredientOwnership };
