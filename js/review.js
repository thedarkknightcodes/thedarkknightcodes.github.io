/**
 * review.js — the weekly review card shown at the top of Today (Phase 7):
 * a short warm summary of the week, a few wins, and up to three short lists
 * of task suggestions the person can tick or untick before applying.
 *
 * Split out of ui.js purely to keep that file a manageable size — same
 * reasoning as sheets.js (the popups) being its own file. app.js still
 * owns *what happens* when you tick a box and press "Apply ticked" (it
 * builds the view model with real task titles, and reacts to the
 * handlers below); this file only knows *how to draw* a review that's
 * already been turned into that view model.
 *
 * Nothing here ever shows a count of undone tasks, and the "Looks stale"
 * list starts UNticked — dropping something is the one action in this
 * card that should never happen by accident.
 */

function el(id) { return document.getElementById(id); }
function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// Only one review card can be on screen at a time, and renderReview() can
// be called many times in a row (any store change re-renders Today) — this
// tracks the Escape-key listener from the MOST RECENT render, so each call
// swaps it out cleanly instead of piling up duplicate listeners.
let activeKeydownCleanup = null;

/**
 * Builds one section (suggested / someday / drop): a heading, a list of
 * {id, title, reason} rows each with a pre-set checkbox, and returns the
 * checkboxes so the caller can read their final ticked state later without
 * re-querying the DOM.
 */
function buildSection(heading, items, defaultChecked) {
  const section = document.createElement("div");
  section.className = "review-section";

  const h = document.createElement("h3");
  h.className = "review-section-title";
  h.textContent = heading;
  section.appendChild(h);

  const list = document.createElement("ul");
  list.className = "review-list";
  const checkboxes = [];

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "review-row";

    const label = document.createElement("label");
    label.className = "review-check-label";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = defaultChecked;
    checkbox.dataset.id = item.id;
    checkboxes.push(checkbox);
    label.appendChild(checkbox);

    const text = document.createElement("span");
    text.className = "review-item-text";
    const title = document.createElement("span");
    title.className = "review-item-title";
    title.textContent = item.title;
    text.appendChild(title);
    if (item.reason) {
      const reason = document.createElement("span");
      reason.className = "review-item-reason";
      reason.textContent = item.reason;
      text.appendChild(reason);
    }
    label.appendChild(text);

    li.appendChild(label);
    list.appendChild(li);
  }

  section.appendChild(list);
  return { section: section, checkboxes: checkboxes, visible: items.length > 0 };
}

/**
 * Draws the review card into #review-card, or hides it if `review` is
 * null/undefined. `review` is a view model (see app.js's
 * buildReviewViewModel): { week_start, source, summary, wins,
 * suggested/someday/drop: [{id, title, reason}] } — titles already looked
 * up, unknown ids already dropped, so this file never has to touch
 * state.tasks itself.
 *
 * `handlers.onApply(accept)` is called with `{ suggested: [ids],
 * someday: [ids], drop: [ids] }` — just the ids whose checkbox ended up
 * ticked. `handlers.onDismiss()` is called by both "Not now" and Escape.
 */
export function renderReview(review, handlers) {
  if (activeKeydownCleanup) {
    activeKeydownCleanup();
    activeKeydownCleanup = null;
  }

  const container = el("review-card");
  if (!container) return;
  clearChildren(container);

  if (!review) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const headingRow = document.createElement("div");
  headingRow.className = "review-heading-row";
  const h2 = document.createElement("h2");
  h2.className = "card-title";
  h2.textContent = "Your week, reviewed";
  headingRow.appendChild(h2);
  const tag = document.createElement("span");
  tag.className = "review-source-tag";
  tag.textContent = "by " + (review.source === "claude" ? "Claude" : "Gemini");
  headingRow.appendChild(tag);
  container.appendChild(headingRow);

  const summary = document.createElement("p");
  summary.className = "card-copy";
  summary.textContent = review.summary || "";
  container.appendChild(summary);

  if (review.wins && review.wins.length) {
    const winsList = document.createElement("ul");
    winsList.className = "review-wins-list";
    for (const w of review.wins) {
      const li = document.createElement("li");
      li.textContent = "✓ " + w;
      winsList.appendChild(li);
    }
    container.appendChild(winsList);
  }

  // Suggestions and someday candidates are pre-ticked (accepting the
  // review's advice is the easy default) — dropping something is not, so
  // that never happens with a single, half-noticed tap.
  const suggested = buildSection("This week", review.suggested || [], true);
  const someday = buildSection("Could rest in Someday", review.someday || [], true);
  const drop = buildSection("Looks stale", review.drop || [], false);

  if (suggested.visible) container.appendChild(suggested.section);
  if (someday.visible) container.appendChild(someday.section);
  if (drop.visible) container.appendChild(drop.section);

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "btn btn-primary";
  applyBtn.textContent = "Apply ticked";
  applyBtn.addEventListener("click", function () {
    handlers.onApply({
      suggested: suggested.checkboxes.filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.id; }),
      someday: someday.checkboxes.filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.id; }),
      drop: drop.checkboxes.filter(function (c) { return c.checked; }).map(function (c) { return c.dataset.id; }),
    });
  });
  actions.appendChild(applyBtn);

  const notNowBtn = document.createElement("button");
  notNowBtn.type = "button";
  notNowBtn.className = "btn btn-quiet";
  notNowBtn.textContent = "Not now";
  notNowBtn.addEventListener("click", function () { handlers.onDismiss(); });
  actions.appendChild(notNowBtn);

  container.appendChild(actions);

  // Escape dismisses the card the same way "Not now" does — this isn't a
  // <dialog>, so there's no free native handling for that the way the
  // action/edit/settings sheets get.
  function onKeydown(e) {
    if (e.key === "Escape") handlers.onDismiss();
  }
  document.addEventListener("keydown", onKeydown);
  activeKeydownCleanup = function () { document.removeEventListener("keydown", onKeydown); };
}
