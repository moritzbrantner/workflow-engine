const workflowIdInput = document.querySelector("#workflow-id");
const editor = document.querySelector("#definition-editor");
const registerButton = document.querySelector("#register-button");
const registerMessage = document.querySelector("#register-message");
const definitionState = document.querySelector("#definition-state");
const versionCount = document.querySelector("#version-count");
const versionsList = document.querySelector("#versions-list");
const triggerButtons = [...document.querySelectorAll("[data-trigger]")];
const triggerMessage = document.querySelector("#trigger-message");
const runStatus = document.querySelector("#run-status");
const runRecord = document.querySelector("#run-record");
const timelineSteps = [...document.querySelectorAll(".timeline-step")];

const definitions = new Map();
let runInProgress = false;
let nextRunId = 1;

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function demoFingerprint(value) {
  const text = stableStringify(value);
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619) >>> 0;
    second = Math.imul(second ^ code, 3266489917) >>> 0;
  }
  return `demo:${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function validateWorkflow(workflow) {
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) throw new Error("Definition must be a JSON object.");
  if (workflow.format !== "@moritzbrantner/workflow/compiled") throw new Error("Unexpected compiled workflow format.");
  if (workflow.version !== 1) throw new Error("Compiled workflow schema version must be 1.");
  if (!Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges) || !Array.isArray(workflow.order)) {
    throw new Error("nodes, edges, and order must be arrays.");
  }
}

function currentWorkflowId() {
  const workflowId = workflowIdInput.value.trim();
  if (!workflowId) throw new Error("Workflow ID is required.");
  return workflowId;
}

function getVersions(workflowId) {
  return definitions.get(workflowId) ?? [];
}

function setPill(element, text, state = "neutral") {
  element.textContent = text;
  element.className = `status-pill ${state}`;
}

function shortFingerprint(value) {
  return value.length > 18 ? `${value.slice(0, 13)}…${value.slice(-4)}` : value;
}

function renderVersions(workflowId) {
  const versions = getVersions(workflowId);
  versionCount.textContent = `${versions.length} ${versions.length === 1 ? "version" : "versions"}`;

  if (versions.length === 0) {
    versionsList.className = "version-list empty-state";
    versionsList.textContent = "Register the definition to create version 1.";
    return;
  }

  versionsList.className = "version-list";
  versionsList.replaceChildren(...[...versions].reverse().map((definition) => {
    const row = document.createElement("div");
    row.className = "version-row";
    const version = document.createElement("strong");
    version.textContent = `v${definition.version}`;
    const digest = document.createElement("code");
    digest.textContent = shortFingerprint(definition.workflowDigest);
    digest.title = `${definition.workflowDigest} (browser demo fingerprint; production engine uses SHA-256)`;
    const time = document.createElement("time");
    time.dateTime = definition.createdAt;
    time.textContent = new Date(definition.createdAt).toLocaleTimeString();
    row.append(version, digest, time);
    return row;
  }));
}

function registerDefinition() {
  registerMessage.textContent = "";
  try {
    const workflowId = currentWorkflowId();
    const workflow = JSON.parse(editor.value);
    validateWorkflow(workflow);
    const workflowDigest = demoFingerprint(workflow);
    const versions = getVersions(workflowId);
    const latest = versions.at(-1);

    if (latest?.workflowDigest === workflowDigest) {
      setPill(definitionState, `v${latest.version} unchanged`, "success");
      registerMessage.textContent = "Idempotent registration: the latest definition is unchanged.";
      renderVersions(workflowId);
      return;
    }

    const definition = {
      workflowId,
      version: (latest?.version ?? 0) + 1,
      workflowDigest,
      workflow: structuredClone(workflow),
      createdAt: new Date().toISOString(),
    };
    definitions.set(workflowId, [...versions, definition]);
    setPill(definitionState, `registered v${definition.version}`, "success");
    registerMessage.textContent = `Created immutable version ${definition.version}. The production engine uses its SHA-256 workflow digest; this static demo uses ${workflowDigest}.`;
    renderVersions(workflowId);
  } catch (error) {
    setPill(definitionState, "invalid", "error");
    registerMessage.textContent = error instanceof Error ? error.message : String(error);
  }
}

function setTimeline(status) {
  const active = status === "queued" ? ["queued"] : status === "running" ? ["queued", "running"] : ["queued", "running", "succeeded"];
  timelineSteps.forEach((step) => step.classList.toggle("active", active.includes(step.dataset.step)));
}

function renderRun(run) {
  const state = run.status === "succeeded" ? "success" : "running";
  setPill(runStatus, run.status, state);
  setTimeline(run.status);
  runRecord.textContent = JSON.stringify(run, null, 2);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function triggerInput(type) {
  if (type === "manual") return { source: "manual" };
  if (type === "webhook") return { body: { source: "github-pages" }, headers: {}, query: {} };
  return { scheduledAt: new Date().toISOString() };
}

async function runDemo(type) {
  if (runInProgress) return;
  triggerMessage.textContent = "";
  try {
    const workflowId = currentWorkflowId();
    const latest = getVersions(workflowId).at(-1);
    if (!latest) throw new Error("Register a definition before firing a trigger.");

    runInProgress = true;
    triggerButtons.forEach((button) => { button.disabled = true; });
    const createdAt = new Date().toISOString();
    const run = {
      id: `demo-run-${nextRunId++}`,
      workflowId,
      workflowVersion: latest.version,
      workflowDigest: latest.workflowDigest,
      triggerId: `${type}-demo`,
      status: "queued",
      input: triggerInput(type),
      context: {},
      createdAt,
    };

    triggerMessage.textContent = `${type} resolved ${workflowId}@${latest.version}; the run record is now pinned to that definition.`;
    renderRun(run);
    await delay(300);
    run.status = "running";
    run.startedAt = new Date().toISOString();
    renderRun(run);
    await delay(650);
    run.status = "succeeded";
    run.output = { simulated: true, message: "Runner-shaped dispatcher returned success." };
    run.finishedAt = new Date().toISOString();
    renderRun(run);
  } catch (error) {
    triggerMessage.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    runInProgress = false;
    triggerButtons.forEach((button) => { button.disabled = false; });
  }
}

registerButton.addEventListener("click", registerDefinition);
workflowIdInput.addEventListener("input", () => {
  const workflowId = workflowIdInput.value.trim();
  renderVersions(workflowId);
  setPill(definitionState, getVersions(workflowId).length ? "registered" : "unregistered");
});
editor.addEventListener("input", () => {
  if (getVersions(workflowIdInput.value.trim()).length > 0) setPill(definitionState, "edited");
});
triggerButtons.forEach((button) => button.addEventListener("click", () => runDemo(button.dataset.trigger)));
