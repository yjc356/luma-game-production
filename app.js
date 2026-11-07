(() => {
  "use strict";

  const STORAGE_KEY = "luma-game-production-v1";
  const state = {
    tasks: [],
    view: "dashboard",
    pipeline: "all",
    phase: "all",
    priority: "all",
    query: "",
    layout: "board"
  };
  let toastTimer;
  let saveTimer;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (value = "") => String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const pipelineOf = task => PIPELINES[task.pipeline] || PIPELINES.client;
  const phaseOf = id => PHASES.find(phase => phase.id === id) || PHASES[0];
  const statusOf = id => STATUSES.find(status => status.id === id) || STATUSES[0];
  const average = values => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
  const icon = (name, className = "") => `<svg${className ? ` class="${className}"` : ""}><use href="#i-${name}"/></svg>`;

  function init() {
    loadTasks();
    fillFormOptions();
    bindEvents();
    renderStaticContent();
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
      localStorage.setItem(backupKey, JSON.stringify({ version: 1, tasks: state.tasks }));
    }
    state.tasks = tasks.map(normalizeTask).filter(task => task.id && task.title);
    persistLocalTasks();
    renderAll();
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
    return {
      id: String(task.id || ""),
      title: String(task.title || ""),
      pipeline: PIPELINES[task.pipeline] ? task.pipeline : "client",
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
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tasks: state.tasks }));
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
    $("#task-pipeline").innerHTML = Object.entries(PIPELINES).map(([id, pipeline]) => `<option value="${id}">${pipeline.name}</option>`).join("");
    $("#task-phase").innerHTML = PHASES.map(phase => `<option value="${phase.id}">${phase.id} · ${phase.name}</option>`).join("");
    $("#task-status").innerHTML = STATUSES.map(status => `<option value="${status.id}">${status.name}</option>`).join("");
    $("#phase-filter").innerHTML += PHASES.map(phase => `<option value="${phase.id}">${phase.id} · ${phase.name}</option>`).join("");
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
    document.addEventListener("keydown", event => {
      if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName) && !$("#task-dialog").open) {
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
    const remaining = state.tasks.filter(task => task.status !== "done").reduce((sum, task) => sum + Number(task.estimate || 0), 0);
    $("#dashboard-stats").innerHTML = `
      <article class="stat-card primary-stat"><span>整体开发进度</span><div class="stat-value"><strong>${overall}</strong><small>%</small></div><div class="stat-bar"><i style="width:${overall}%"></i></div><span class="stat-aside">所有任务平均</span></article>
      <article class="stat-card"><span>正在推进</span><div class="stat-value"><strong>${active}</strong><small>项</small></div><span class="stat-aside">含待验证任务</span></article>
      <article class="stat-card"><span>已完成</span><div class="stat-value"><strong>${done}</strong><small>/ ${total} 项</small></div><div class="stat-bar"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></div></article>
      <article class="stat-card"><span>剩余预估工作量</span><div class="stat-value"><strong>${Math.round(remaining * 10) / 10}</strong><small>人日</small></div><span class="stat-aside">不含新增任务</span></article>`;

    $("#pipeline-cards").innerHTML = Object.entries(PIPELINES).map(([id, pipeline]) => {
      const tasks = state.tasks.filter(task => task.pipeline === id);
      const progress = average(tasks.map(task => Number(task.progress)));
      const doneCount = tasks.filter(task => task.status === "done").length;
      const activeCount = tasks.filter(task => ["doing", "review"].includes(task.status)).length;
      return `<button class="pipeline-card" data-pipeline="${id}" style="--accent:${pipeline.color}">
        <div class="pipeline-card-top"><span class="pipeline-icon">${pipeline.short}</span><span class="pipeline-name"><strong>${pipeline.name}</strong><small>${pipeline.en}</small></span><span class="pipeline-percent">${progress}<small>%</small></span></div>
        <div class="stat-bar"><i style="width:${progress}%"></i></div>
        <div class="pipeline-card-foot"><span>${doneCount} / ${tasks.length} 已完成</span><span>${activeCount ? `${activeCount} 项进行中` : pipeline.description}</span></div>
      </button>`;
    }).join("");

    const focus = state.tasks
      .filter(task => task.status !== "done" && task.priority === "P0")
      .sort((a, b) => PHASES.findIndex(phase => phase.id === a.phase) - PHASES.findIndex(phase => phase.id === b.phase) || ["client", "network", "render", "animation", "vfx"].indexOf(a.pipeline) - ["client", "network", "render", "animation", "vfx"].indexOf(b.pipeline) || a.id.localeCompare(b.id))
      .slice(0, 5);
    $("#focus-list").innerHTML = focus.length ? focus.map((task, index) => `<button class="focus-item" data-task-id="${esc(task.id)}"><span class="focus-index">${String(index + 1).padStart(2, "0")}</span><span><strong>${esc(task.title)}</strong><small>${esc(task.id)} · ${phaseOf(task.phase).id} ${phaseOf(task.phase).name} · ${pipelineOf(task).name}</small></span>${icon("chevron")}</button>`).join("") : `<div class="empty-mini">当前没有待推进的 P0 任务。<br>可以进入下一阶段，或新建一个目标。</div>`;

    $("#mini-roadmap").innerHTML = PHASES.map(phase => {
      const tasks = state.tasks.filter(task => task.phase === phase.id);
      const isDone = tasks.length && tasks.every(task => task.status === "done");
      const isActive = !isDone && tasks.some(task => task.progress > 0 || task.status !== "todo");
      return `<div class="mini-phase${isDone ? " done" : ""}${isActive ? " active" : ""}"><span class="mini-dot"></span><strong>${phase.id} · ${phase.name}</strong><small>${tasks.filter(task => task.status === "done").length} / ${tasks.length} 项完成</small></div>`;
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
    $("#pipeline-filters").innerHTML = [`<button class="filter-pill${state.pipeline === "all" ? " active" : ""}" data-filter-pipeline="all">全部管线 <b>${state.tasks.length}</b></button>`, ...Object.entries(PIPELINES).map(([id, pipeline]) => {
      const count = state.tasks.filter(task => task.pipeline === id).length;
      return `<button class="filter-pill${state.pipeline === id ? " active" : ""}" data-filter-pipeline="${id}" style="--accent:${pipeline.color}"><i></i>${pipeline.name}<b>${count}</b></button>`;
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
      <span class="card-pipeline"><i></i>${pipeline.name} · ${task.phase}</span>
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
      return `<tr data-task-id="${esc(task.id)}"><td><span class="task-id">${esc(task.id)}</span></td><td>${esc(task.title)}</td><td><span class="table-pipeline" style="--accent:${pipeline.color}"><i></i>${pipeline.name} · ${task.phase}</span></td><td><span class="priority ${task.priority}">${task.priority}</span></td><td><span class="status-chip" style="--status-color:${status.color}">${status.name}</span></td><td><div class="table-progress"><div class="stat-bar"><i style="width:${task.progress}%;background:${pipeline.color}"></i></div><span>${task.progress}%</span></div></td><td>${task.estimate} 人日</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  function renderRoadmap() {
    $("#roadmap").innerHTML = PHASES.map(phase => {
      const tasks = state.tasks.filter(task => task.phase === phase.id);
      const progress = average(tasks.map(task => Number(task.progress)));
      return `<section class="phase-column"><div class="phase-header"><div class="phase-num"><span>${phase.id} / ${phase.en}</span><b>${tasks.length} 项</b></div><h2>${phase.name}</h2><p>${phase.goal}</p><div class="phase-progress"><div class="stat-bar"><i style="width:${progress}%"></i></div><small>${progress}%</small></div></div><div class="phase-body"><div class="phase-gate"><strong>阶段出口条件</strong>${phase.gate}</div><div class="phase-tasks">${tasks.slice(0, 6).map(task => `<button class="phase-task${task.status === "done" ? " done" : ""}" data-task-id="${esc(task.id)}"><i></i><span>${esc(task.title)}</span></button>`).join("")}${tasks.length > 6 ? `<button class="phase-more" data-phase-more="${phase.id}">查看其余 ${tasks.length - 6} 项任务 →</button>` : ""}</div></div></section>`;
    }).join("");
  }

  function renderStaticContent() {
    $("#workflow-steps").innerHTML = WORKFLOW.map((step, index) => `<article class="workflow-step"><span>0${index + 1}</span><strong>${step.name}</strong><p>${step.text}</p></article>`).join("");
  }

  function openTaskDialog(id = "") {
    if (!id && !ensureCanEdit()) return;
    const task = id ? state.tasks.find(item => item.id === id) : null;
    if (id && !task) return;
    $("#task-form").reset();
    $("#task-id").value = task?.id || "";
    $("#dialog-kicker").textContent = task ? `EDIT TASK / ${task.id}` : "NEW TASK";
    $("#dialog-title").textContent = task ? "编辑开发任务" : "新建开发任务";
    $("#task-title").value = task?.title || "";
    $("#task-pipeline").value = task?.pipeline || (state.pipeline !== "all" ? state.pipeline : "client");
    $("#task-phase").value = task?.phase || (state.phase !== "all" ? state.phase : "M0");
    $("#task-priority").value = task?.priority || "P1";
    $("#task-status").value = task?.status || "todo";
    $("#task-estimate").value = task?.estimate ?? 1;
    $("#task-due").value = task?.due || "";
    $("#task-description").value = task?.description || "";
    $("#task-deliverable").value = task?.deliverable || "";
    $("#task-acceptance").value = task?.acceptance || "";
    $("#task-dependencies").value = task?.dependencies || "";
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

  function saveTaskFromForm(event) {
    event.preventDefault();
    if (!ensureCanEdit()) return;
    const id = $("#task-id").value;
    const existing = state.tasks.find(task => task.id === id);
    const nextTask = normalizeTask({
      id: id || `U-${(globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).toUpperCase()}`, 
      title: $("#task-title").value.trim(),
      pipeline: $("#task-pipeline").value,
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

  function exportData() {
    const payload = { app: "LUMA Game Production", version: 1, exportedAt: new Date().toISOString(), tasks: state.tasks };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `LUMA-开发任务-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("备份已导出");
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
        if (!window.confirm(`将用备份中的 ${imported.length} 项任务替换当前 ${state.tasks.length} 项任务。建议先导出当前数据，是否继续？`)) return;
        state.tasks = imported;
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

  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"), 2400);
  }

  init();
})();
