(() => {
  "use strict";

  const STORAGE_KEY = "luma-game-production-v1";
  const PIPELINES_KEY = "luma-pipelines";
  const PITFALLS_KEY = "luma-pitfalls";
  const NEW_PIPELINE_VALUE = "__new__";

  const state = {
    tasks: [],
    customPipelines: {},
    pitfalls: [],
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

  function pipelineOrder() {
    const builtin = Object.keys(PIPELINES);
    const custom = Object.keys(state.customPipelines).filter(id => !PIPELINES[id]);
    return [...builtin, ...custom];
  }

  function init() {
    loadCustomPipelines();
    loadPitfalls();
    loadTasks();
    fillFormOptions();
    bindEvents();
    $("#today-date").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
    renderAll();
    window.LumaCloud.init({
      getLocalTasks: () => state.tasks,
      onRemoteTasks: applyCloudTasks,
      onError: toast
    }).catch(error => toast(`协作功能初始化失败：${error.message}`));
  }

  function applyCloudTasks(tasks) {
    const backupKey = `${STORAGE_KEY}-before-cloud`;
    if (!localStorage.getItem(backupKey)) {
      localStorage.setItem(backupKey, JSON.stringify({ version: 2, tasks: state.tasks, pipelines: state.customPipelines, pitfalls: state.pitfalls }));
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
        return;
      }
    } catch (error) {
      console.warn("无法读取开发备忘", error);
    }
    state.pitfalls = (typeof DEFAULT_PITFALLS !== "undefined" ? DEFAULT_PITFALLS : []).map(item => ({ ...item }));
    persistPitfalls();
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

  function normalizeTask(task) {
    const pipelineId = String(task.pipeline || "").trim() || "client";
    return {
      id: String(task.id || ""),
      title: String(task.title || ""),
      pipeline: pipelineId,
      phase: PHASES.some(phase => phase.id === task.phase) ? task.phase : "M0",
      priority: ["P0", "P1", "P2"].includes(task.priority) ? task.priority : "P1",
      status: STATUSES.some(status => status.id === task.status) ? task.status : "todo",
      progress: Math.min(100, Math.max(0, Number(task.progress) || 0)),
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
    $("#task-progress").addEventListener("input", event => {
      $("#progress-output").textContent = `${event.target.value}%`;
      const status = $("#task-status");
      if (Number(event.target.value) === 100) status.value = "done";
      else if (Number(event.target.value) > 0 && status.value === "todo") status.value = "doing";
      else if (status.value === "done") status.value = "doing";
    });
    $("#task-status").addEventListener("change", event => {
      if (event.target.value === "done") setFormProgress(100);
      else if (event.target.value === "todo" && $("#task-progress").value === "100") setFormProgress(0);
    });
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
    if (status === "done") task.progress = 100;
    if (status === "todo") task.progress = 0;
    if (status === "doing" && task.progress === 100) task.progress = 90;
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
    const overall = average(state.tasks.map(task => Number(task.progress)));
    const active = state.tasks.filter(task => ["doing", "review"].includes(task.status)).length;
    const done = state.tasks.filter(task => task.status === "done").length;
    const blocked = state.tasks.filter(task => task.status === "blocked").length;
    const remaining = state.tasks.filter(task => task.status !== "done").reduce((sum, task) => sum + Number(task.estimate || 0), 0);
    const pitfallCount = state.pitfalls.length;
    $("#dashboard-stats").innerHTML = `
      <article class="stat-card primary-stat"><span>制作进度</span><div class="stat-value"><strong>${overall}</strong><small>%</small></div><div class="stat-bar"><i style="width:${overall}%"></i></div><span class="stat-aside">全管线任务平均</span></article>
      <article class="stat-card"><span>正在推进</span><div class="stat-value"><strong>${active}</strong><small>项</small></div><span class="stat-aside">${blocked ? `${blocked} 项阻塞` : "含待验证"}</span></article>
      <article class="stat-card"><span>已完成</span><div class="stat-value"><strong>${done}</strong><small>/ ${total} 项</small></div><div class="stat-bar"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></div></article>
      <article class="stat-card"><span>剩余人日 / 备忘</span><div class="stat-value"><strong>${Math.round(remaining * 10) / 10}</strong><small>人日</small></div><span class="stat-aside">${pitfallCount} 条开发坑点</span></article>`;

    const budgets = typeof PRODUCTION_BUDGETS !== "undefined" ? PRODUCTION_BUDGETS : [];
    $("#budget-cards").innerHTML = budgets.map(budget => `
      <article class="budget-card budget-${esc(budget.id)}">
        <span class="budget-tier">${esc(budget.name)}</span>
        <strong>${esc(budget.target)}</strong>
        <p><b>GI</b> ${esc(budget.gi)}</p>
        <small>${esc(budget.note)}</small>
      </article>`).join("");

    const all = getAllPipelines();
    const title = $("#pipeline-panel-title");
    if (title) title.textContent = `制作管线（${pipelineOrder().length}）`;
    $("#pipeline-cards").innerHTML = pipelineOrder().map(id => {
      const pipeline = all[id];
      const tasks = state.tasks.filter(task => task.pipeline === id);
      const progress = average(tasks.map(task => Number(task.progress)));
      const doneCount = tasks.filter(task => task.status === "done").length;
      const activeCount = tasks.filter(task => ["doing", "review"].includes(task.status)).length;
      const notes = state.pitfalls.filter(item => item.pipeline === id).length;
      return `<button class="pipeline-card" data-pipeline="${esc(id)}" style="--accent:${pipeline.color}">
        <div class="pipeline-card-top"><span class="pipeline-icon">${esc(pipeline.short)}</span><span class="pipeline-name"><strong>${esc(pipeline.name)}</strong><small>${esc(pipeline.en)}</small></span><span class="pipeline-percent">${progress}<small>%</small></span></div>
        <div class="stat-bar"><i style="width:${progress}%"></i></div>
        <div class="pipeline-card-foot"><span>${doneCount} / ${tasks.length} 已完成</span><span>${activeCount ? `${activeCount} 项进行中` : notes ? `${notes} 条备忘` : esc(pipeline.description)}</span></div>
      </button>`;
    }).join("");

    const focus = state.tasks
      .filter(task => task.status !== "done" && task.priority === "P0")
      .sort((a, b) => PHASES.findIndex(phase => phase.id === a.phase) - PHASES.findIndex(phase => phase.id === b.phase) || pipelineOrder().indexOf(a.pipeline) - pipelineOrder().indexOf(b.pipeline) || a.id.localeCompare(b.id))
      .slice(0, 5);
    $("#focus-list").innerHTML = focus.length ? focus.map((task, index) => `<button class="focus-item" data-task-id="${esc(task.id)}"><span class="focus-index">${String(index + 1).padStart(2, "0")}</span><span><strong>${esc(task.title)}</strong><small>${esc(task.id)} · ${phaseOf(task.phase).id} ${esc(phaseOf(task.phase).name)} · ${esc(pipelineOf(task).name)}</small></span>${icon("chevron")}</button>`).join("") : `<div class="empty-mini">当前没有待推进的 P0 任务<br>可以进入下一阶段，或新建一个目标。</div>`;

    $("#mini-roadmap").innerHTML = PHASES.map(phase => {
      const tasks = state.tasks.filter(task => task.phase === phase.id);
      const isDone = tasks.length && tasks.every(task => task.status === "done");
      const isActive = !isDone && tasks.some(task => task.progress > 0 || task.status !== "todo");
      return `<div class="mini-phase${isDone ? " done" : ""}${isActive ? " active" : ""}"><span class="mini-dot"></span><strong>${phase.id} · ${esc(phase.name)}</strong><small>${tasks.filter(task => task.status === "done").length} / ${tasks.length} · 闸门</small></div>`;
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
    return `<article class="task-card" draggable="true" data-task-id="${esc(task.id)}" style="--accent:${pipeline.color}">
      <div class="task-card-top"><span class="task-id">${esc(task.id)}</span><span class="priority ${task.priority}">${task.priority}</span></div>
      <h3>${esc(task.title)}</h3>
      <span class="card-pipeline"><i></i>${esc(pipeline.name)} · ${task.phase}</span>
      <div class="card-progress"><div class="stat-bar"><i style="width:${task.progress}%"></i></div><small>${task.progress}%</small></div>
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
    $("#task-list").innerHTML = `<table class="task-table"><thead><tr><th>编号</th><th>任务</th><th>管线 / 阶段</th><th>优先级</th><th>状态</th><th>进度</th><th>预估</th></tr></thead><tbody>${tasks.map(task => {
      const pipeline = pipelineOf(task);
      const status = statusOf(task.status);
      return `<tr data-task-id="${esc(task.id)}"><td><span class="task-id">${esc(task.id)}</span></td><td>${esc(task.title)}</td><td><span class="table-pipeline" style="--accent:${pipeline.color}"><i></i>${esc(pipeline.name)} · ${task.phase}</span></td><td><span class="priority ${task.priority}">${task.priority}</span></td><td><span class="status-chip" style="--status-color:${status.color}">${status.name}</span></td><td><div class="table-progress"><div class="stat-bar"><i style="width:${task.progress}%;background:${pipeline.color}"></i></div><span>${task.progress}%</span></div></td><td>${task.estimate} 人日</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  function renderRoadmap() {
    $("#roadmap").innerHTML = PHASES.map(phase => {
      const tasks = state.tasks.filter(task => task.phase === phase.id);
      const progress = average(tasks.map(task => Number(task.progress)));
      return `<section class="phase-column"><div class="phase-header"><div class="phase-num"><span>${phase.id} / ${phase.en}</span><b>${tasks.length} 项</b></div><h2>${esc(phase.name)}</h2><p>${esc(phase.goal)}</p><div class="phase-progress"><div class="stat-bar"><i style="width:${progress}%"></i></div><small>${progress}%</small></div></div><div class="phase-body"><div class="phase-gate"><strong>阶段出口条件</strong>${esc(phase.gate)}</div><div class="phase-tasks">${tasks.slice(0, 6).map(task => `<button class="phase-task${task.status === "done" ? " done" : ""}" data-task-id="${esc(task.id)}"><i></i><span>${esc(task.title)}</span></button>`).join("")}${tasks.length > 6 ? `<button class="phase-more" data-phase-more="${phase.id}">查看其余 ${tasks.length - 6} 项任务 →</button>` : ""}</div></div></section>`;
    }).join("");
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
    setFormProgress(task?.progress || 0);
    $("#delete-task").hidden = !task;
    $("#task-dialog").showModal();
    requestAnimationFrame(() => $("#task-title").focus());
  }

  function closeTaskDialog() {
    $("#task-dialog").close();
  }

  function setFormProgress(value) {
    $("#task-progress").value = value;
    $("#progress-output").textContent = `${value}%`;
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
    const nextTask = normalizeTask({
      id: id || `U-${(globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).toUpperCase()}`,
      title: $("#task-title").value.trim(),
      pipeline: pipelineValue,
      phase: $("#task-phase").value,
      priority: $("#task-priority").value,
      status: $("#task-status").value,
      progress: $("#task-status").value === "done" ? 100 : $("#task-progress").value,
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
      version: 2,
      exportedAt: new Date().toISOString(),
      tasks: state.tasks,
      pipelines: state.customPipelines,
      pitfalls: state.pitfalls
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
    toast("备份已导出（含管线与备忘）");
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
        if (!window.confirm(`将用备份中的 ${imported.length} 项任务替换当前 ${state.tasks.length} 项任务，并合并自定义管线 / 开发备忘。建议先导出当前数据，是否继续？`)) return;
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
