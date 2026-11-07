(() => {
  "use strict";

  const STORAGE_KEY = "luma-game-production-v1";
  const PIPELINES_KEY = "luma-pipelines";
  const PITFALLS_KEY = "luma-pitfalls";
  const RENDER_TIERS_KEY = "luma-render-tiers";
  const NEW_PIPELINE_VALUE = "__new__";

  const state = {
    tasks: [],
    customPipelines: {},
    pitfalls: [],
    renderTiers: [],
    editingBudgets: false,
    view: "dashboard",
    pipeline: "all",
    phase: "all",
    priority: "all",
    query: "",
    layout: "board",
    pitfallPipeline: "render"
  };
  let toastTimer;
  let saveTimer;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = "") => String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const phaseOf = id => PHASES.find(phase => phase.id === id) || PHASES[0];
  const statusOf = id => STATUSES.find(status => status.id === id) || STATUSES[0];
  const average = values => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  const icon = (name, className = "") => `<svg${className ? ` class="${className}"` : ""}><use href="#i-${name}"/></svg>`;
  const uid = prefix => `${prefix}-${(globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "").slice(0, 12)}`;

  function getAllPipelines() {
    return { ...PIPELINES, ...state.customPipelines };
  }

  function pipelineOf(taskOrId) {
    const id = typeof taskOrId === "string" ? taskOrId : taskOrId?.pipeline;
    const all = getAllPipelines();
    return all[id] || { name: id || "未知管线", en: "CUSTOM", short: "?", color: "#8a948c", description: "自定义或已归档管线" };
  }


  function stepOf(id) {
    const steps = typeof WORKFLOW_STEPS !== "undefined" ? WORKFLOW_STEPS : [];
    return steps.find(step => step.id === id) || steps[0] || { id: "define", name: "定义" };
  }

  function stepIndex(id) {
    const steps = typeof WORKFLOW_STEPS !== "undefined" ? WORKFLOW_STEPS : [];
    const index = steps.findIndex(step => step.id === id);
    return index < 0 ? 0 : index;
  }

  function inferStepFromStatus(status, current) {
    if (status === "done") return "deliver";
    if (status === "review") return "verify";
    if (status === "todo") return current && current !== "deliver" ? current : "define";
    if (status === "doing" && (!current || current === "define" || current === "deliver")) return "implement";
    return current || "implement";
  }

  function loadRenderTiers() {
    const defaults = (typeof PRODUCTION_BUDGETS !== "undefined" ? PRODUCTION_BUDGETS : []).map(item => ({ ...item }));
    try {
      const saved = JSON.parse(localStorage.getItem(RENDER_TIERS_KEY) || "null");
      if (Array.isArray(saved) && saved.length) {
        const byId = Object.fromEntries(saved.map(item => [item.id, item]));
        state.renderTiers = defaults.map(seed => normalizeRenderTier({ ...seed, ...(byId[seed.id] || {}) }));
        // keep any extra custom tiers user added
        saved.forEach(item => {
          if (!defaults.some(seed => seed.id === item.id)) state.renderTiers.push(normalizeRenderTier(item));
        });
        return;
      }
    } catch (error) {
      console.warn("无法读取三档渲染目标", error);
    }
    state.renderTiers = defaults.map(item => normalizeRenderTier(item));
    persistRenderTiers();
  }

  function persistRenderTiers() {
    localStorage.setItem(RENDER_TIERS_KEY, JSON.stringify(state.renderTiers));
  }

  function normalizeRenderTier(tier = {}) {
    const id = String(tier.id || "custom").slice(0, 24) || "custom";
    return {
      id,
      name: String(tier.name || id).slice(0, 24),
      target: String(tier.target || "").slice(0, 80),
      gi: String(tier.gi || "").slice(0, 80),
      note: String(tier.note || "").slice(0, 160)
    };
  }

  function pipelineOrder() {
    const builtin = Object.keys(PIPELINES);
    const custom = Object.keys(state.customPipelines).filter(id => !PIPELINES[id]);
    return [...builtin, ...custom];
  }

  function init() {
    loadCustomPipelines();
    loadPitfalls();
    loadRenderTiers();
    loadTasks();
    const seeded = mergeSeedTasks({ persist: true, cloud: false });
    fillFormOptions();
    bindEvents();
    $("#today-date").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
    renderAll();
    window.LumaCloud.init({
      getLocalTasks: () => state.tasks,
      onRemoteTasks: tasks => {
        applyCloudTasks(tasks);
        const added = mergeSeedTasks({ persist: true, cloud: true });
        if (added.length) toast(`已合并 ${added.length} 项新默认任务到看板`);
      },
      onError: toast
    }).catch(error => toast(`协作功能初始化失败：${error.message}`));
    if (seeded.length) toast(`已加入 ${seeded.length} 项新管线默认任务`);
  }

  function applyCloudTasks(tasks) {
    const backupKey = `${STORAGE_KEY}-before-cloud`;
    if (!localStorage.getItem(backupKey)) {
      localStorage.setItem(backupKey, JSON.stringify({ version: 3, tasks: state.tasks, pipelines: state.customPipelines, pitfalls: state.pitfalls, renderTiers: state.renderTiers }));
    }
    state.tasks = tasks.map(normalizeTask).filter(task => task.id && task.title);
    persistLocalTasks();
    renderAll();
  }

  function loadCustomPipelines() {
    try {
      const saved = JSON.parse(localStorage.getItem(PIPELINES_KEY) || "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        state.customPipelines = Object.fromEntries(
          Object.entries(saved)
            .filter(([id, pipeline]) => id && pipeline && pipeline.name && !PIPELINES[id])
            .map(([id, pipeline]) => [id, normalizePipeline(id, pipeline)])
        );
      }
    } catch (error) {
      console.warn("无法读取自定义管线", error);
      state.customPipelines = {};
    }
  }

  function persistCustomPipelines() {
    localStorage.setItem(PIPELINES_KEY, JSON.stringify(state.customPipelines));
  }

  function normalizePipeline(id, pipeline = {}) {
    const short = String(pipeline.short || pipeline.name || id).slice(0, 2) || "?";
    return {
      name: String(pipeline.name || id).slice(0, 24),
      en: String(pipeline.en || id).toUpperCase().slice(0, 24),
      short,
      color: /^#[0-9a-fA-F]{6}$/.test(pipeline.color || "") ? pipeline.color : "#6b8f71",
      description: String(pipeline.description || "自定义制作管线").slice(0, 80),
      custom: true
    };
  }

  function slugifyPipelineId(name) {
    const base = String(name || "custom")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 18) || "custom";
    let id = `x-${base}`.replace(/[^\w\-]/g, "");
    if (!id.startsWith("x-")) id = `x-${Date.now().toString(36)}`;
    const all = getAllPipelines();
    if (!all[id]) return id;
    return `${id}-${Math.random().toString(36).slice(2, 5)}`;
  }

  function loadPitfalls() {
    try {
      const saved = JSON.parse(localStorage.getItem(PITFALLS_KEY));
      if (saved && Array.isArray(saved.pitfalls)) {
        state.pitfalls = saved.pitfalls.map(normalizePitfall).filter(item => item.id && item.title);
        mergeDefaultPitfalls();
        return;
      }
    } catch (error) {
      console.warn("无法读取开发备忘", error);
    }
    state.pitfalls = (typeof DEFAULT_PITFALLS !== "undefined" ? DEFAULT_PITFALLS : []).map(item => ({ ...item }));
    persistPitfalls();
  }

  function mergeDefaultPitfalls() {
    const defaults = typeof DEFAULT_PITFALLS !== "undefined" ? DEFAULT_PITFALLS : [];
    const existing = new Set(state.pitfalls.map(item => item.id));
    let changed = false;
    defaults.forEach(item => {
      if (!item?.id || existing.has(item.id)) return;
      state.pitfalls.push({ ...item });
      existing.add(item.id);
      changed = true;
    });
    if (changed) persistPitfalls();
  }

  function persistPitfalls() {
    localStorage.setItem(PITFALLS_KEY, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), pitfalls: state.pitfalls }));
  }

  function normalizePitfall(item = {}) {
    return {
      id: String(item.id || uid("pit")),
      pipeline: String(item.pipeline || "render"),
      title: String(item.title || "").slice(0, 80),
      body: String(item.body || ""),
      relatedTaskId: String(item.relatedTaskId || "").slice(0, 24),
      createdAt: String(item.createdAt || new Date().toISOString()),
      updatedAt: String(item.updatedAt || item.createdAt || new Date().toISOString())
    };
  }

  function loadTasks() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (saved && Array.isArray(saved.tasks)) {
        state.tasks = saved.tasks.map(normalizeTask).filter(task => task.id && task.title);
        return;
      }
    } catch (error) {
      console.warn("无法读取本地任务数据，已载入默认任务。", error);
    }
    state.tasks = DEFAULT_TASKS.map(task => ({ ...task }));
  }

  function mergeSeedTasks({ persist = true, cloud = false } = {}) {
    const existing = new Set(state.tasks.map(task => task.id));
    const added = [];
    DEFAULT_TASKS.forEach(seed => {
      if (!seed?.id || existing.has(seed.id)) return;
      const task = normalizeTask({ ...seed });
      state.tasks.push(task);
      existing.add(task.id);
      added.push(task);
    });
    if (!added.length) return [];
    if (persist) persistLocalTasks();
    if (cloud && window.LumaCloud?.isActive?.() && window.LumaCloud.canEdit()) {
      added.forEach(task => {
        window.LumaCloud.commit({ type: "upsert", task }).catch(error => toast(error.message));
      });
    }
    return added.map(task => task.id);
  }

  function normalizeTask(task) {
    const pipelineId = String(task.pipeline || "").trim() || "client";
    const status = STATUSES.some(item => item.id === task.status) ? task.status : "todo";
    const steps = typeof WORKFLOW_STEPS !== "undefined" ? WORKFLOW_STEPS : [];
    let step = String(task.step || "").trim();
    if (!steps.some(item => item.id === step)) {
      // migrate old percent progress into a step label once
      const legacy = Number(task.progress);
      if (Number.isFinite(legacy) && legacy >= 100) step = "deliver";
      else if (Number.isFinite(legacy) && legacy >= 85) step = "verify";
      else if (Number.isFinite(legacy) && legacy >= 70) step = "integrate";
      else if (Number.isFinite(legacy) && legacy >= 45) step = "implement";
      else if (Number.isFinite(legacy) && legacy >= 20) step = "research";
      else step = inferStepFromStatus(status, "define");
    }
    const note = String(task.stepNote || task.progressNote || "").slice(0, 80);
    return {
      id: String(task.id || ""),
      title: String(task.title || ""),
      pipeline: pipelineId,
      phase: PHASES.some(phase => phase.id === task.phase) ? task.phase : "M0",
      priority: ["P0", "P1", "P2"].includes(task.priority) ? task.priority : "P1",
      status,
      step,
      stepNote: note,
      estimate: Math.max(0, Number(task.estimate) || 0),
      description: String(task.description || ""),
      deliverable: String(task.deliverable || ""),
      acceptance: String(task.acceptance || ""),
      dependencies: String(task.dependencies || ""),
      due: String(task.due || ""),
      custom: Boolean(task.custom)
    };
  }

  function saveTasks(cloudChange) {
    persistLocalTasks();
    if (cloudChange && window.LumaCloud.isActive()) {
      window.LumaCloud.commit(cloudChange).catch(error => toast(error.message));
    }
  }

  function persistLocalTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 2,
        updatedAt: new Date().toISOString(),
        tasks: state.tasks
      }));
      if (!window.LumaCloud?.isActive()) $("#save-state").innerHTML = "<i></i>已保存到本地";
      const saveState = $("#save-state");
      clearTimeout(saveTimer);
      saveState.style.opacity = "1";
      saveTimer = setTimeout(() => { saveState.style.opacity = ".65"; }, 1200);
    } catch (error) {
      $("#save-state").textContent = "保存失败，请导出备份";
      toast("本地保存失败，请立即导出备份");
      console.error(error);
    }
  }

  function ensureCanEdit() {
    if (window.LumaCloud.canEdit()) return true;
    toast("你是观察员，只能查看任务，不能修改");
    return false;
  }

  function fillFormOptions() {
    fillPipelineSelects();
    $("#task-phase").innerHTML = PHASES.map(phase => `<option value="${phase.id}">${phase.id} · ${phase.name}</option>`).join("");
    $("#task-status").innerHTML = STATUSES.map(status => `<option value="${status.id}">${status.name}</option>`).join("");
    const stepSelect = $("#task-step");
    if (stepSelect) {
      const steps = typeof WORKFLOW_STEPS !== "undefined" ? WORKFLOW_STEPS : [];
      stepSelect.innerHTML = steps.map(step => `<option value="${step.id}">${step.name}</option>`).join("");
    }
    const phaseFilter = $("#phase-filter");
    const existing = new Set([...phaseFilter.options].map(option => option.value));
    PHASES.forEach(phase => {
      if (existing.has(phase.id)) return;
      phaseFilter.insertAdjacentHTML("beforeend", `<option value="${phase.id}">${phase.id} · ${phase.name}</option>`);
    });
  }

  function fillPipelineSelects(selectedTaskPipeline, selectedPitfallPipeline) {
    const all = getAllPipelines();
    const options = pipelineOrder().map(id => {
      const pipeline = all[id];
      const tag = pipeline.custom ? "（自定义）" : "";
      return `<option value="${esc(id)}">${esc(pipeline.name)}${tag}</option>`;
    }).join("");
    $("#task-pipeline").innerHTML = `${options}<option value="${NEW_PIPELINE_VALUE}">+ 新建管线…</option>`;
    $("#pitfall-pipeline").innerHTML = options;
    if (selectedTaskPipeline && all[selectedTaskPipeline]) $("#task-pipeline").value = selectedTaskPipeline;
    if (selectedPitfallPipeline && all[selectedPitfallPipeline]) $("#pitfall-pipeline").value = selectedPitfallPipeline;
    toggleNewPipelineFields();
  }

  function toggleNewPipelineFields() {
    const show = $("#task-pipeline").value === NEW_PIPELINE_VALUE;
    const box = $("#new-pipeline-fields");
    if (!box) return;
    box.hidden = !show;
    if (show && !$("#new-pipeline-name").value) {
      $("#new-pipeline-name").focus();
    }
  }

  function bindEvents() {
    $$("[data-view]").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
    $$("[data-view-link]").forEach(button => button.addEventListener("click", () => showView(button.dataset.viewLink)));
    $$("[data-go-tasks]").forEach(button => button.addEventListener("click", () => openTasks(button.dataset.goTasks)));
    $("#add-task-btn").addEventListener("click", () => openTaskDialog());
    $("#global-search").addEventListener("input", event => {
      state.query = event.target.value.trim();
      if (state.query && state.view !== "tasks") showView("tasks");
      renderTasks();
    });
    $("#phase-filter").addEventListener("change", event => { state.phase = event.target.value; renderTasks(); });
    $("#priority-filter").addEventListener("change", event => { state.priority = event.target.value; renderTasks(); });
    $$("[data-layout]").forEach(button => button.addEventListener("click", () => {
      state.layout = button.dataset.layout;
      $$("[data-layout]").forEach(item => item.classList.toggle("active", item === button));
      renderTasks();
    }));
    $("#task-board").addEventListener("click", handleTaskClick);
    $("#task-list").addEventListener("click", handleTaskClick);
    $("#focus-list").addEventListener("click", handleTaskClick);
    $("#mini-roadmap").addEventListener("click", handleTaskClick);
    const studio = $("#studio-checklist");
    if (studio) {
      studio.addEventListener("click", event => {
        const link = event.target.closest("[data-view-link]");
        if (link) {
          event.preventDefault();
          showView(link.dataset.viewLink);
          return;
        }
        const taskButton = event.target.closest("[data-task-id]");
        if (taskButton && taskButton.dataset.taskId) openTaskDialog(taskButton.dataset.taskId);
      });
    }
    $("#roadmap").addEventListener("click", event => {
      const taskButton = event.target.closest("[data-task-id]");
      if (taskButton) openTaskDialog(taskButton.dataset.taskId);
      const moreButton = event.target.closest("[data-phase-more]");
      if (moreButton) {
        state.phase = moreButton.dataset.phaseMore;
        $("#phase-filter").value = state.phase;
        openTasks("all");
      }
    });
    $("#pipeline-cards").addEventListener("click", event => {
      const card = event.target.closest("[data-pipeline]");
      if (card) openTasks(card.dataset.pipeline);
    });
    $("#pipeline-filters").addEventListener("click", event => {
      const button = event.target.closest("[data-filter-pipeline]");
      if (!button) return;
      state.pipeline = button.dataset.filterPipeline;
      renderTasks();
    });
    $("#active-search").addEventListener("click", () => {
      state.query = "";
      $("#global-search").value = "";
      renderTasks();
    });
    $("#task-form").addEventListener("submit", saveTaskFromForm);
    $("#task-pipeline").addEventListener("change", toggleNewPipelineFields);
    const stepSelect = $("#task-step");
    if (stepSelect) {
      stepSelect.addEventListener("change", event => {
        const status = $("#task-status");
        if (event.target.value === "deliver") status.value = "done";
        else if (event.target.value === "verify" && status.value === "todo") status.value = "review";
        else if (event.target.value !== "define" && status.value === "todo") status.value = "doing";
        else if (status.value === "done" && event.target.value !== "deliver") status.value = "doing";
      });
    }
    $("#task-status").addEventListener("change", event => {
      const step = $("#task-step");
      if (!step) return;
      step.value = inferStepFromStatus(event.target.value, step.value);
    });
    const budgetCards = $("#budget-cards");
    if (budgetCards) {
      budgetCards.addEventListener("input", event => {
        const field = event.target.closest("[data-tier-field]");
        if (!field) return;
        const card = field.closest("[data-tier-id]");
        if (!card) return;
        const tier = state.renderTiers.find(item => item.id === card.dataset.tierId);
        if (!tier) return;
        tier[field.dataset.tierField] = field.value;
        persistRenderTiers();
      });
    }
    const editBudgets = $("#edit-budgets-btn");
    if (editBudgets) {
      editBudgets.addEventListener("click", () => {
        state.editingBudgets = !state.editingBudgets;
        renderDashboard();
        toast(state.editingBudgets ? "正在编辑三档目标（自动保存到本机）" : "已退出编辑");
      });
    }
    const resetBudgets = $("#reset-budgets-btn");
    if (resetBudgets) {
      resetBudgets.addEventListener("click", () => {
        if (!window.confirm("恢复默认三档渲染目标？你改过的文字会被覆盖。")) return;
        state.renderTiers = (typeof PRODUCTION_BUDGETS !== "undefined" ? PRODUCTION_BUDGETS : []).map(item => normalizeRenderTier(item));
        persistRenderTiers();
        state.editingBudgets = false;
        renderDashboard();
        toast("已恢复默认三档目标");
      });
    }
    $("#close-dialog").addEventListener("click", closeTaskDialog);
    $("#cancel-dialog").addEventListener("click", closeTaskDialog);
    $("#task-dialog").addEventListener("click", event => {
      if (event.target === $("#task-dialog")) closeTaskDialog();
    });
    $("#delete-task").addEventListener("click", deleteCurrentTask);
    $("#export-btn").addEventListener("click", exportData);
    $("#import-btn").addEventListener("click", () => $("#import-file").click());
    $("#import-file").addEventListener("change", importData);
    $("#add-pitfall-btn").addEventListener("click", () => openPitfallDialog());
    $("#pitfall-form").addEventListener("submit", savePitfallFromForm);
    $("#close-pitfall-dialog").addEventListener("click", closePitfallDialog);
    $("#cancel-pitfall-dialog").addEventListener("click", closePitfallDialog);
    $("#delete-pitfall").addEventListener("click", deleteCurrentPitfall);
    $("#pitfall-dialog").addEventListener("click", event => {
      if (event.target === $("#pitfall-dialog")) closePitfallDialog();
    });
    $("#pitfall-pipeline-list").addEventListener("click", event => {
      const button = event.target.closest("[data-pitfall-pipeline]");
      if (!button) return;
      state.pitfallPipeline = button.dataset.pitfallPipeline;
      renderPitfalls();
    });
    $("#pitfalls-list").addEventListener("click", event => {
      const edit = event.target.closest("[data-edit-pitfall]");
      if (edit) {
        openPitfallDialog(edit.dataset.editPitfall);
        return;
      }
      const related = event.target.closest("[data-open-task]");
      if (related) openTaskDialog(related.dataset.openTask);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && !$("#task-dialog").open && !$("#pitfall-dialog").open) {
        event.preventDefault();
        $("#global-search").focus();
      }
    });
    bindDragAndDrop();
  }

  function bindDragAndDrop() {
    const board = $("#task-board");
    board.addEventListener("dragstart", event => {
      const card = event.target.closest(".task-card");
      if (!card) return;
      event.dataTransfer.setData("text/plain", card.dataset.taskId);
      event.dataTransfer.effectAllowed = "move";
      requestAnimationFrame(() => card.classList.add("dragging"));
    });
    board.addEventListener("dragend", event => {
      event.target.closest(".task-card")?.classList.remove("dragging");
      $$(".board-column").forEach(column => column.classList.remove("drag-over"));
    });
    board.addEventListener("dragover", event => {
      const column = event.target.closest(".board-column");
      if (!column) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      $$(".board-column").forEach(item => item.classList.toggle("drag-over", item === column));
    });
    board.addEventListener("drop", event => {
      const column = event.target.closest(".board-column");
      if (!column) return;
      event.preventDefault();
      const task = state.tasks.find(item => item.id === event.dataTransfer.getData("text/plain"));
      if (task && task.status !== column.dataset.status) {
        if (updateTaskStatus(task, column.dataset.status)) toast(`“${task.title}”已移至${statusOf(task.status).name}`);
      }
      $$(".board-column").forEach(item => item.classList.remove("drag-over"));
    });
  }

  function handleTaskClick(event) {
    const complete = event.target.closest("[data-complete-id]");
    if (complete) {
      event.stopPropagation();
      const task = state.tasks.find(item => item.id === complete.dataset.completeId);
      if (task) {
        if (updateTaskStatus(task, task.status === "done" ? "doing" : "done")) toast(task.status === "done" ? "任务已完成" : "任务已重新打开");
      }
      return;
    }
    const target = event.target.closest("[data-task-id]");
    if (target) openTaskDialog(target.dataset.taskId);
  }

  function updateTaskStatus(task, status) {
    if (!ensureCanEdit()) return false;
    task.status = status;
    task.step = inferStepFromStatus(status, task.step);
    saveTasks({ type: "upsert", task });
    renderAll();
    return true;
  }

  function showView(view) {
    if (!["dashboard", "tasks", "roadmap", "guide"].includes(view)) return;
    state.view = view;
    $$(".view").forEach(section => section.classList.toggle("active", section.id === `view-${view}`));
    $$(".nav-item[data-view]").forEach(button => button.classList.toggle("active", button.dataset.view === view));
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (view === "dashboard") renderDashboard();
    if (view === "tasks") renderTasks();
    if (view === "roadmap") renderRoadmap();
    if (view === "guide") renderPitfalls();
  }

  function openTasks(pipeline = "all") {
    state.pipeline = pipeline;
    showView("tasks");
    renderTasks();
  }

  function renderAll() {
    renderDashboard();
    renderTasks();
    renderRoadmap();
    renderPitfalls();
    const total = state.tasks.length;
    const done = state.tasks.filter(task => task.status === "done").length;
    $("#nav-task-count").textContent = total;
    $("#side-total").textContent = total;
    $("#side-done").textContent = done;
    $("#side-progress").style.width = `${total ? Math.round(done / total * 100) : 0}%`;
  }

  function renderDashboard() {
    const total = state.tasks.length;
    const steps = typeof WORKFLOW_STEPS !== "undefined" ? WORKFLOW_STEPS : [];
    const stepScore = total ? Math.round(state.tasks.reduce((sum, task) => sum + stepIndex(task.step), 0) / Math.max(steps.length - 1, 1) / total * 100) : 0;
    const active = state.tasks.filter(task => ["doing", "review"].includes(task.status)).length;
    const done = state.tasks.filter(task => task.status === "done").length;
    const blocked = state.tasks.filter(task => task.status === "blocked").length;
    const remaining = state.tasks.filter(task => task.status !== "done").reduce((sum, task) => sum + Number(task.estimate || 0), 0);
    const pitfallCount = state.pitfalls.length;
    const topStep = steps.length ? steps.reduce((best, step) => {
      const count = state.tasks.filter(task => task.step === step.id && task.status !== "done").length;
      return count > (best.count || 0) ? { ...step, count } : best;
    }, { name: "—", count: 0 }) : { name: "—", count: 0 };
    $("#dashboard-stats").innerHTML = `
      <article class="stat-card primary-stat"><span>推进分布</span><div class="stat-value"><strong>${esc(topStep.name)}</strong><small>当前最多</small></div><div class="stat-bar"><i style="width:${stepScore}%"></i></div><span class="stat-aside">${topStep.count || 0} 项卡在「${esc(topStep.name)}」· 按步骤而非百分比</span></article>
      <article class="stat-card"><span>正在推进</span><div class="stat-value"><strong>${active}</strong><small>项</small></div><span class="stat-aside">${blocked ? `${blocked} 项阻塞` : "含待验证"}</span></article>
      <article class="stat-card"><span>已交付</span><div class="stat-value"><strong>${done}</strong><small>/ ${total} 项</small></div><div class="stat-bar"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></div></article>
      <article class="stat-card"><span>剩余人日 / 备忘</span><div class="stat-value"><strong>${Math.round(remaining * 10) / 10}</strong><small>人日</small></div><span class="stat-aside">${pitfallCount} 条开发坑点</span></article>`;

    const editBtn = $("#edit-budgets-btn");
    if (editBtn) editBtn.textContent = state.editingBudgets ? "完成编辑" : "编辑三档";
    const budgets = state.renderTiers.length ? state.renderTiers : (typeof PRODUCTION_BUDGETS !== "undefined" ? PRODUCTION_BUDGETS : []);
    $("#budget-cards").innerHTML = budgets.map(budget => {
      if (state.editingBudgets) {
        return `<article class="budget-card budget-editable budget-${esc(budget.id)}" data-tier-id="${esc(budget.id)}">
          <label class="budget-edit-field"><span>档位名</span><input data-tier-field="name" value="${esc(budget.name)}" maxlength="24"></label>
          <label class="budget-edit-field"><span>帧率 / 目标</span><input data-tier-field="target" value="${esc(budget.target)}" maxlength="80" placeholder="例如：更高卡 · 1080p 144+"></label>
          <label class="budget-edit-field"><span>GI / 反射</span><input data-tier-field="gi" value="${esc(budget.gi)}" maxlength="80" placeholder="例如：Lumen GI + Lumen 反射"></label>
          <label class="budget-edit-field"><span>备注</span><textarea data-tier-field="note" rows="2" maxlength="160" placeholder="阴影、后处理、物理预留等">${esc(budget.note)}</textarea></label>
        </article>`;
      }
      return `<article class="budget-card budget-${esc(budget.id)}" data-tier-id="${esc(budget.id)}">
        <span class="budget-tier">${esc(budget.name)}</span>
        <strong>${esc(budget.target)}</strong>
        <p><b>GI / 反射</b> ${esc(budget.gi)}</p>
        <small>${esc(budget.note)}</small>
      </article>`;
    }).join("");

    const all = getAllPipelines();
    const title = $("#pipeline-panel-title");
    if (title) title.textContent = `制作管线（${pipelineOrder().length}）`;
    $("#pipeline-cards").innerHTML = pipelineOrder().map(id => {
      const pipeline = all[id];
      const tasks = state.tasks.filter(task => task.pipeline === id);
      const maxStep = Math.max((typeof WORKFLOW_STEPS !== "undefined" ? WORKFLOW_STEPS.length : 1) - 1, 1);
      const progress = tasks.length ? Math.round(tasks.reduce((sum, task) => sum + stepIndex(task.step), 0) / maxStep / tasks.length * 100) : 0;
      const doneCount = tasks.filter(task => task.status === "done").length;
      const activeCount = tasks.filter(task => ["doing", "review"].includes(task.status)).length;
      const notes = state.pitfalls.filter(item => item.pipeline === id).length;
      const hot = tasks.filter(task => task.status !== "done").sort((a, b) => stepIndex(b.step) - stepIndex(a.step))[0];
      return `<button class="pipeline-card" data-pipeline="${esc(id)}" style="--accent:${pipeline.color}">
        <div class="pipeline-card-top"><span class="pipeline-icon">${esc(pipeline.short)}</span><span class="pipeline-name"><strong>${esc(pipeline.name)}</strong><small>${esc(pipeline.en)}</small></span><span class="pipeline-percent">${doneCount}<small>/${tasks.length}</small></span></div>
        <div class="stat-bar"><i style="width:${progress}%"></i></div>
        <div class="pipeline-card-foot"><span>${hot ? `多在「${esc(stepOf(hot.step).name)}」` : `${doneCount} 已交付`}</span><span>${activeCount ? `${activeCount} 项进行中` : notes ? `${notes} 条备忘` : esc(pipeline.description)}</span></div>
      </button>`;
    }).join("");

    const focus = state.tasks
      .filter(task => task.status !== "done" && task.priority === "P0")
      .sort((a, b) => PHASES.findIndex(phase => phase.id === a.phase) - PHASES.findIndex(phase => phase.id === b.phase) || pipelineOrder().indexOf(a.pipeline) - pipelineOrder().indexOf(b.pipeline) || a.id.localeCompare(b.id))
      .slice(0, 5);
    $("#focus-list").innerHTML = focus.length ? focus.map((task, index) => `<button class="focus-item" data-task-id="${esc(task.id)}"><span class="focus-index">${String(index + 1).padStart(2, "0")}</span><span><strong>${esc(task.title)}</strong><small>${esc(task.id)} · ${phaseOf(task.phase).id} ${esc(phaseOf(task.phase).name)} · ${esc(pipelineOf(task).name)}</small></span>${icon("chevron")}</button>`).join("") : `<div class="empty-mini">当前没有待推进的 P0 任务<br>可以去制作清单挑一项，或新建小需求。</div>`;

    const checklist = typeof STUDIO_CHECKLIST !== "undefined" ? STUDIO_CHECKLIST : [];
    const flat = checklist.flatMap(group => group.items.map(item => ({ ...item, group: group.group })));
    $("#mini-roadmap").innerHTML = flat.slice(0, 6).map(item => {
      const linked = item.taskHint ? state.tasks.find(task => task.id === item.taskHint) : null;
      const done = linked ? linked.status === "done" : false;
      const stepName = linked ? stepOf(linked.step).name : "";
      const active = linked && !done && linked.step && linked.step !== "define";
      return `<button class="mini-check${done ? " done" : ""}${active ? " active" : ""}" data-task-id="${esc(linked?.id || "")}" ${linked ? "" : "disabled"}>
        <span class="mini-dot"></span>
        <strong>${esc(item.title)}</strong>
        <small>${linked ? `${esc(linked.id)} · ${esc(stepName)}${linked.stepNote ? ` · ${esc(linked.stepNote)}` : ""}` : "见制作清单"}</small>
      </button>`;
    }).join("");
  }

  function filteredTasks() {
    const query = state.query.toLocaleLowerCase("zh-CN");
    return state.tasks.filter(task => {
      const matchesPipeline = state.pipeline === "all" || task.pipeline === state.pipeline;
      const matchesPhase = state.phase === "all" || task.phase === state.phase;
      const matchesPriority = state.priority === "all" || task.priority === state.priority;
      const haystack = `${task.id} ${task.title} ${task.description} ${task.deliverable} ${task.acceptance} ${task.dependencies}`.toLocaleLowerCase("zh-CN");
      return matchesPipeline && matchesPhase && matchesPriority && (!query || haystack.includes(query));
    });
  }

  function renderTasks() {
    const all = getAllPipelines();
    $("#pipeline-filters").innerHTML = [`<button class="filter-pill${state.pipeline === "all" ? " active" : ""}" data-filter-pipeline="all">全部管线 <b>${state.tasks.length}</b></button>`, ...pipelineOrder().map(id => {
      const pipeline = all[id];
      const count = state.tasks.filter(task => task.pipeline === id).length;
      return `<button class="filter-pill${state.pipeline === id ? " active" : ""}" data-filter-pipeline="${esc(id)}" style="--accent:${pipeline.color}"><i></i>${esc(pipeline.name)}<b>${count}</b></button>`;
    })].join("");
    $("#phase-filter").value = state.phase;
    $("#priority-filter").value = state.priority;
    const searchNotice = $("#active-search");
    searchNotice.hidden = !state.query;
    if (state.query) searchNotice.innerHTML = `搜索“<strong>${esc(state.query)}</strong>” · 找到 ${filteredTasks().length} 项 <button>清除搜索</button>`;
    const tasks = filteredTasks();
    if (state.layout === "board") {
      $("#task-board").hidden = false;
      $("#task-list").hidden = true;
      renderBoard(tasks);
    } else {
      $("#task-board").hidden = true;
      $("#task-list").hidden = false;
      renderTaskList(tasks);
    }
  }

  function taskCard(task) {
    const pipeline = pipelineOf(task);
    const due = task.due ? formatDate(task.due) : `${task.estimate} 人日`;
    const step = stepOf(task.step);
    const note = task.stepNote ? ` · ${esc(task.stepNote)}` : "";
    return `<article class="task-card" draggable="true" data-task-id="${esc(task.id)}" style="--accent:${pipeline.color}">
      <div class="task-card-top"><span class="task-id">${esc(task.id)}</span><span class="priority ${task.priority}">${task.priority}</span></div>
      <h3>${esc(task.title)}</h3>
      <span class="card-pipeline"><i></i>${esc(pipeline.name)} · ${task.phase}</span>
      <div class="card-step"><span class="step-chip step-${esc(task.step)}">${esc(step.name)}</span><small>${esc(step.name)}阶段${note}</small></div>
      <button class="complete-btn" data-complete-id="${esc(task.id)}" title="${task.status === "done" ? "重新打开" : "标记完成"}">${icon("check")}</button>
      <div class="task-card-foot"><span>${icon("clock")}${esc(due)}</span><span>${task.priority === "P0" ? "核心路径" : task.priority === "P1" ? "重要功能" : "增强功能"}</span></div>
    </article>`;
  }

  function renderBoard(tasks) {
    $("#task-board").innerHTML = STATUSES.map(status => {
      const columnTasks = tasks.filter(task => task.status === status.id);
      return `<section class="board-column" data-status="${status.id}" style="--status-color:${status.color}"><div class="column-heading"><i></i><strong>${status.name}</strong><span>${columnTasks.length}</span></div><div class="column-cards">${columnTasks.length ? columnTasks.map(taskCard).join("") : `<div class="empty-column">拖动任务到这里</div>`}</div></section>`;
    }).join("");
  }

  function renderTaskList(tasks) {
    if (!tasks.length) {
      $("#task-list").innerHTML = `<div class="empty-state">没有符合当前筛选条件的任务。</div>`;
      return;
    }
    $("#task-list").innerHTML = `<table class="task-table"><thead><tr><th>编号</th><th>任务</th><th>管线 / 阶段</th><th>优先级</th><th>状态</th><th>做到哪一步</th><th>预估</th></tr></thead><tbody>${tasks.map(task => {
      const pipeline = pipelineOf(task);
      const status = statusOf(task.status);
      const step = stepOf(task.step);
      const note = task.stepNote ? `<small class="step-note">${esc(task.stepNote)}</small>` : "";
      return `<tr data-task-id="${esc(task.id)}"><td><span class="task-id">${esc(task.id)}</span></td><td>${esc(task.title)}</td><td><span class="table-pipeline" style="--accent:${pipeline.color}"><i></i>${esc(pipeline.name)} · ${task.phase}</span></td><td><span class="priority ${task.priority}">${task.priority}</span></td><td><span class="status-chip" style="--status-color:${status.color}">${status.name}</span></td><td><div class="table-step"><span class="step-chip step-${esc(task.step)}">${esc(step.name)}</span>${note}</div></td><td>${task.estimate} 人日</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  function renderRoadmap() {
    const checklist = typeof STUDIO_CHECKLIST !== "undefined" ? STUDIO_CHECKLIST : [];
    const studio = $("#studio-checklist");
    if (studio) {
      studio.innerHTML = checklist.map(group => {
        const cards = group.items.map(item => {
          const linked = item.taskHint ? state.tasks.find(task => task.id === item.taskHint) : null;
          const status = linked ? statusOf(linked.status).name : "清单项";
          const stepName = linked ? stepOf(linked.step).name : "";
          const done = linked?.status === "done";
          return `<article class="studio-card${done ? " done" : ""}">
            <div class="studio-card-top"><strong>${esc(item.title)}</strong>${item.taskHint ? `<span class="task-id">${esc(item.taskHint)}</span>` : `<span class="task-id">备忘</span>`}</div>
            <p>${esc(item.detail)}</p>
            <div class="studio-card-foot"><span>${esc(status)}${linked ? ` · ${esc(stepName)}${linked.stepNote ? ` · ${esc(linked.stepNote)}` : ""}` : ""}</span>${linked ? `<button type="button" class="text-btn" data-task-id="${esc(linked.id)}">打开任务</button>` : `<button type="button" class="text-btn" data-view-link="guide">去写备忘</button>`}</div>
          </article>`;
        }).join("");
        return `<section class="studio-group"><div class="panel-heading"><div><span class="section-kicker">CHECKLIST</span><h2>${esc(group.group)}</h2></div></div><div class="studio-grid">${cards}</div></section>`;
      }).join("");
    }

    const road = $("#roadmap");
    if (road) {
      road.innerHTML = PHASES.map(phase => {
        const tasks = state.tasks.filter(task => task.phase === phase.id);
        const done = tasks.filter(task => task.status === "done").length;
        return `<button class="phase-chip" data-phase-more="${phase.id}" title="${esc(phase.goal)}"><b>${phase.id}</b><span>${esc(phase.name)}</span><small>${done}/${tasks.length}</small></button>`;
      }).join("");
    }
  }

  function renderPitfalls() {
    const all = getAllPipelines();
    if (!all[state.pitfallPipeline]) state.pitfallPipeline = pipelineOrder()[0] || "render";
    $("#pitfall-pipeline-list").innerHTML = pipelineOrder().map(id => {
      const pipeline = all[id];
      const count = state.pitfalls.filter(item => item.pipeline === id).length;
      return `<button class="pitfall-pipeline-item${state.pitfallPipeline === id ? " active" : ""}" data-pitfall-pipeline="${esc(id)}" style="--accent:${pipeline.color}"><span class="pipeline-icon">${esc(pipeline.short)}</span><span><strong>${esc(pipeline.name)}</strong><small>${count} 条备忘</small></span></button>`;
    }).join("");
    const pipeline = pipelineOf(state.pitfallPipeline);
    $("#pitfall-pipeline-heading").textContent = pipeline.name;
    const notes = state.pitfalls
      .filter(item => item.pipeline === state.pitfallPipeline)
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    $("#pitfall-count").textContent = `${notes.length} 条`;
    if (!notes.length) {
      $("#pitfalls-list").innerHTML = `<div class="empty-state pitfalls-empty">这条管线还没有备忘。<br>开发结束后点右上角「记录新坑」，给后续 agent / 自己留下记忆。</div>`;
      return;
    }
    $("#pitfalls-list").innerHTML = notes.map(note => `
      <article class="pitfall-card" style="--accent:${pipeline.color}">
        <div class="pitfall-card-top">
          <div><h3>${esc(note.title)}</h3><small>${formatDateTime(note.updatedAt || note.createdAt)}${note.relatedTaskId ? ` · <button type="button" class="linkish" data-open-task="${esc(note.relatedTaskId)}">${esc(note.relatedTaskId)}</button>` : ""}</small></div>
          <button type="button" class="secondary-btn compact-btn" data-edit-pitfall="${esc(note.id)}">编辑</button>
        </div>
        <pre class="pitfall-body">${esc(note.body)}</pre>
      </article>`).join("");
  }

  function openTaskDialog(id = "") {
    if (!id && !ensureCanEdit()) return;
    const task = id ? state.tasks.find(item => item.id === id) : null;
    if (id && !task) return;
    $("#task-form").reset();
    fillPipelineSelects(task?.pipeline || (state.pipeline !== "all" ? state.pipeline : "client"));
    $("#task-id").value = task?.id || "";
    $("#dialog-kicker").textContent = task ? `EDIT TASK / ${task.id}` : "NEW TASK";
    $("#dialog-title").textContent = task ? "编辑开发任务" : "新建开发任务";
    $("#task-title").value = task?.title || "";
    $("#task-pipeline").value = task?.pipeline || (state.pipeline !== "all" && getAllPipelines()[state.pipeline] ? state.pipeline : "client");
    $("#task-phase").value = task?.phase || (state.phase !== "all" ? state.phase : "M0");
    $("#task-priority").value = task?.priority || "P1";
    $("#task-status").value = task?.status || "todo";
    if ($("#task-step")) $("#task-step").value = task?.step || "define";
    if ($("#task-step-note")) $("#task-step-note").value = task?.stepNote || "";
    $("#task-estimate").value = task?.estimate ?? 1;
    $("#task-due").value = task?.due || "";
    $("#task-description").value = task?.description || "";
    $("#task-deliverable").value = task?.deliverable || "";
    $("#task-acceptance").value = task?.acceptance || "";
    $("#task-dependencies").value = task?.dependencies || "";
    $("#new-pipeline-name").value = "";
    $("#new-pipeline-short").value = "";
    $("#new-pipeline-en").value = "";
    $("#new-pipeline-color").value = "#6b8f71";
    toggleNewPipelineFields();
    $("#delete-task").hidden = !task;
    $("#task-dialog").showModal();
    requestAnimationFrame(() => $("#task-title").focus());
  }

  function closeTaskDialog() {
    $("#task-dialog").close();
  }


  function createPipelineFromForm() {
    const name = $("#new-pipeline-name").value.trim();
    if (!name) {
      toast("请填写新管线名称");
      $("#new-pipeline-name").focus();
      return null;
    }
    const id = slugifyPipelineId(name);
    const short = ($("#new-pipeline-short").value.trim() || name).slice(0, 2);
    const en = ($("#new-pipeline-en").value.trim() || name).toUpperCase();
    const color = $("#new-pipeline-color").value || "#6b8f71";
    state.customPipelines[id] = normalizePipeline(id, {
      name,
      short,
      en,
      color,
      description: "自定义制作管线"
    });
    persistCustomPipelines();
    fillPipelineSelects(id, state.pitfallPipeline);
    return id;
  }

  function saveTaskFromForm(event) {
    event.preventDefault();
    if (!ensureCanEdit()) return;
    let pipelineValue = $("#task-pipeline").value;
    if (pipelineValue === NEW_PIPELINE_VALUE) {
      pipelineValue = createPipelineFromForm();
      if (!pipelineValue) return;
    }
    const id = $("#task-id").value;
    const existing = state.tasks.find(task => task.id === id);
    const status = $("#task-status").value;
    const step = $("#task-step")?.value || inferStepFromStatus(status, "define");
    const nextTask = normalizeTask({
      id: id || `U-${(globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).toUpperCase()}`,
      title: $("#task-title").value.trim(),
      pipeline: pipelineValue,
      phase: $("#task-phase").value,
      priority: $("#task-priority").value,
      status,
      step: status === "done" ? "deliver" : step,
      stepNote: ($("#task-step-note")?.value || "").trim(),
      estimate: $("#task-estimate").value,
      due: $("#task-due").value,
      description: $("#task-description").value.trim(),
      deliverable: $("#task-deliverable").value.trim(),
      acceptance: $("#task-acceptance").value.trim(),
      dependencies: $("#task-dependencies").value.trim(),
      custom: existing?.custom ?? true
    });
    if (!nextTask.title) return;
    if (existing) Object.assign(existing, nextTask);
    else state.tasks.push(nextTask);
    saveTasks({ type: "upsert", task: existing || nextTask });
    renderAll();
    closeTaskDialog();
    toast(existing ? "任务已更新" : "新任务已添加");
  }

  function deleteCurrentTask() {
    if (!ensureCanEdit()) return;
    const id = $("#task-id").value;
    const task = state.tasks.find(item => item.id === id);
    if (!task || !window.confirm(`确定删除“${task.title}”吗？此操作只能通过备份恢复。`)) return;
    state.tasks = state.tasks.filter(item => item.id !== id);
    saveTasks({ type: "delete", id });
    renderAll();
    closeTaskDialog();
    toast("任务已删除");
  }

  function openPitfallDialog(id = "") {
    const note = id ? state.pitfalls.find(item => item.id === id) : null;
    if (id && !note) return;
    fillPipelineSelects($("#task-pipeline").value, note?.pipeline || state.pitfallPipeline);
    $("#pitfall-form").reset();
    $("#pitfall-id").value = note?.id || "";
    $("#pitfall-dialog-kicker").textContent = note ? `EDIT / ${note.id}` : "NEW PITFALL";
    $("#pitfall-dialog-title").textContent = note ? "编辑开发备忘" : "记录开发坑点";
    $("#pitfall-title").value = note?.title || "";
    $("#pitfall-pipeline").value = note?.pipeline || state.pitfallPipeline;
    $("#pitfall-task").value = note?.relatedTaskId || "";
    $("#pitfall-body").value = note?.body || "";
    $("#delete-pitfall").hidden = !note;
    $("#pitfall-dialog").showModal();
    requestAnimationFrame(() => $("#pitfall-title").focus());
  }

  function closePitfallDialog() {
    $("#pitfall-dialog").close();
  }

  function savePitfallFromForm(event) {
    event.preventDefault();
    const id = $("#pitfall-id").value;
    const existing = state.pitfalls.find(item => item.id === id);
    const next = normalizePitfall({
      id: id || uid("pit"),
      title: $("#pitfall-title").value.trim(),
      pipeline: $("#pitfall-pipeline").value,
      relatedTaskId: $("#pitfall-task").value.trim(),
      body: $("#pitfall-body").value.trim(),
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    if (!next.title || !next.body) {
      toast("标题和说明都要填写");
      return;
    }
    if (existing) Object.assign(existing, next);
    else state.pitfalls.push(next);
    state.pitfallPipeline = next.pipeline;
    persistPitfalls();
    renderAll();
    closePitfallDialog();
    toast(existing ? "备忘已更新" : "备忘已记录");
  }

  function deleteCurrentPitfall() {
    const id = $("#pitfall-id").value;
    const note = state.pitfalls.find(item => item.id === id);
    if (!note || !window.confirm(`确定删除备忘“${note.title}”吗？`)) return;
    state.pitfalls = state.pitfalls.filter(item => item.id !== id);
    persistPitfalls();
    renderAll();
    closePitfallDialog();
    toast("备忘已删除");
  }

  function exportData() {
    const payload = {
      app: "LUMA Game Production",
      version: 3,
      exportedAt: new Date().toISOString(),
      tasks: state.tasks,
      pipelines: state.customPipelines,
      pitfalls: state.pitfalls,
      renderTiers: state.renderTiers
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `LUMA-开发任务-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("备份已导出（含管线、备忘与三档目标）");
  }

  function importData(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !ensureCanEdit()) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.tasks)) throw new Error("备份中缺少 tasks 数组");
        const imported = data.tasks.map(normalizeTask).filter(task => task.id && task.title);
        if (!imported.length) throw new Error("备份中没有有效任务");
        if (!window.confirm(`将用备份中的 ${imported.length} 项任务替换当前 ${state.tasks.length} 项任务，并合并自定义管线 / 开发备忘 / 三档目标。建议先导出当前数据，是否继续？`)) return;
        if (data.pipelines && typeof data.pipelines === "object") {
          Object.entries(data.pipelines).forEach(([id, pipeline]) => {
            if (PIPELINES[id]) return;
            state.customPipelines[id] = normalizePipeline(id, pipeline);
          });
          persistCustomPipelines();
        }
        if (Array.isArray(data.pitfalls)) {
          state.pitfalls = data.pitfalls.map(normalizePitfall).filter(item => item.id && item.title);
          persistPitfalls();
        }
        if (Array.isArray(data.renderTiers) && data.renderTiers.length) {
          state.renderTiers = data.renderTiers.map(normalizeRenderTier).filter(item => item.id && item.name);
          persistRenderTiers();
        }
        state.tasks = imported;
        fillPipelineSelects();
        saveTasks({ type: "replace", tasks: imported });
        renderAll();
        toast(`已导入 ${imported.length} 项任务`);
      } catch (error) {
        toast(`导入失败：${error.message}`);
      }
    };
    reader.onerror = () => toast("无法读取所选文件");
    reader.readAsText(file);
  }

  function formatDate(dateString) {
    const date = new Date(`${dateString}T00:00:00`);
    if (Number.isNaN(date.getTime())) return dateString;
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || "";
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }).format(date);
  }

  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 2400);
  }

  init();
})();
