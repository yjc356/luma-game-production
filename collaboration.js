(() => {
  "use strict";

  const config = window.LUMA_CONFIG || {};
  const configured = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
  const clientId = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const $ = selector => document.querySelector(selector);
  const esc = (value = "") => String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);

  let client;
  let channel;
  let user = null;
  let workspace = null;
  let memberships = [];
  let mode = configured ? "loading" : "unconfigured";
  let callbacks = {};
  let operations = [];
  let syncing = false;
  let retryTimer;
  let remoteRefreshPending = false;
  let switchingWorkspace = false;
  let onlineUsers = [];
  let errorMessage = "";

  async function init(options) {
    callbacks = options;
    bindUI();
    render();
    if (!configured) return;
    try {
      await loadSupabase();
      client = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      user = data.session?.user || null;
      if (user) await loadWorkspaces();
      else setMode("signedOut");
      client.auth.onAuthStateChange(event => {
        if (event === "SIGNED_OUT") setTimeout(handleSignedOut, 0);
      });
    } catch (error) {
      fail(error, "云端服务连接失败");
      setMode("signedOut");
    }
  }

  function loadSupabase() {
    if (window.supabase?.createClient) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Supabase JS 加载失败，请检查网络或 CDN 访问"));
      document.head.appendChild(script);
    });
  }

  function setMode(nextMode) {
    mode = nextMode;
    errorMessage = "";
    render();
  }

  function setError(error) {
    errorMessage = error?.message || String(error);
    render();
  }

  function fail(error, prefix = "操作失败") {
    console.error(prefix, error);
    callbacks.onError?.(`${prefix}：${error?.message || error}`);
  }

  async function loadWorkspaces() {
    setMode("loading");
    const { data, error } = await client
      .from("workspace_members")
      .select("role, workspaces(id, name, join_code)")
      .eq("user_id", user.id);
    if (error) throw error;
    memberships = data.filter(item => item.workspaces).map(item => ({
      id: item.workspaces.id,
      name: item.workspaces.name,
      join_code: item.workspaces.join_code,
      role: item.role
    }));
    if (!memberships.length) {
      setMode("noWorkspace");
      return;
    }
    const lastId = localStorage.getItem("luma-active-workspace");
    await activateWorkspace(memberships.find(item => item.id === lastId) || memberships[0]);
  }

  async function activateWorkspace(nextWorkspace) {
    if (!nextWorkspace) return;
    await unsubscribe();
    workspace = nextWorkspace;
    switchingWorkspace = false;
    localStorage.setItem("luma-active-workspace", workspace.id);
    loadOperations();
    setMode("loading");
    const tasks = await fetchTasks();
    if (!tasks.length && !operations.length) {
      const localTasks = callbacks.getLocalTasks?.() || [];
      if (localTasks.length) await replaceTasks(localTasks);
    }
    subscribe();
    await emitTasks();
    setMode("active");
    if (operations.length) flush();
  }

  function outboxKey() {
    return `luma-outbox-${user?.id}-${workspace?.id}`;
  }

  function loadOperations() {
    operations = [];
    try {
      const pending = JSON.parse(localStorage.getItem(outboxKey()) || "[]");
      if (Array.isArray(pending)) operations = pending.filter(item => ["upsert", "delete", "replace"].includes(item.type));
    } catch (error) {
      console.warn("无法恢复待同步队列", error);
    }
  }

  function persistOperations() {
    if (!user || !workspace) return;
    if (operations.length) localStorage.setItem(outboxKey(), JSON.stringify(operations));
    else localStorage.removeItem(outboxKey());
  }

  async function fetchTasks() {
    const { data, error } = await client
      .from("tasks")
      .select("id, data, updated_at")
      .eq("workspace_id", workspace.id)
      .order("id");
    if (error) throw error;
    return data || [];
  }

  async function emitTasks() {
    if (!workspace) return;
    const rows = await fetchTasks();
    let tasks = rows.map(row => row.data);
    for (const operation of operations) {
      if (operation.type === "replace") tasks = [...operation.tasks];
      if (operation.type === "upsert") tasks = [...tasks.filter(task => task.id !== operation.task.id), operation.task];
      if (operation.type === "delete") tasks = tasks.filter(task => task.id !== operation.id);
    }
    callbacks.onRemoteTasks?.(tasks);
  }

  function subscribe() {
    channel = client.channel(`luma-${workspace.id}`, { config: { presence: { key: clientId } } });
    channel
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `workspace_id=eq.${workspace.id}` }, payload => {
        if (payload.new?.client_id === clientId) return;
        if (syncing || operations.length) {
          remoteRefreshPending = true;
          return;
        }
        emitTasks().catch(error => fail(error, "实时同步失败"));
      })
      .on("presence", { event: "sync" }, () => {
        const presence = channel.presenceState();
        onlineUsers = Object.values(presence).flat().filter((item, index, all) => all.findIndex(other => other.user_id === item.user_id) === index);
        renderPresence();
      })
      .subscribe(status => {
        if (status === "SUBSCRIBED") {
          channel.track({ user_id: user.id, email: user.email, client_id: clientId }).catch(error => console.warn("Presence 同步失败", error));
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          $("#save-state").textContent = "实时连接中断，将自动重试";
        }
      });
  }

  async function unsubscribe() {
    if (!channel || !client) return;
    await client.removeChannel(channel);
    channel = null;
    onlineUsers = [];
  }

  async function commit(change) {
    if (!workspace || !user) return;
    if (!canEdit()) throw new Error("观察员没有修改任务的权限");
    if (change.type === "replace") operations = [];
    if (change.type === "upsert") {
      operations = operations.filter(item => !["upsert", "delete"].includes(item.type) || item.task?.id !== change.task.id && item.id !== change.task.id);
    }
    if (change.type === "delete") {
      operations = operations.filter(item => item.type !== "upsert" || item.task.id !== change.id);
    }
    operations.push(change);
    persistOperations();
    await flush();
  }

  async function flush() {
    if (syncing || !workspace) return;
    syncing = true;
    renderSaveState("syncing");
    clearTimeout(retryTimer);
    try {
      while (operations.length) {
        const operation = operations[0];
        if (operation.type === "upsert") await upsertTasks([operation.task]);
        if (operation.type === "delete") await deleteTasks([operation.id]);
        if (operation.type === "replace") await replaceTasks(operation.tasks);
        operations.shift();
        persistOperations();
      }
      await emitTasks();
      remoteRefreshPending = false;
      renderSaveState("active");
    } catch (error) {
      fail(error, "云端保存失败，将自动重试");
      renderSaveState("error");
      retryTimer = setTimeout(() => flush(), 5000);
    } finally {
      syncing = false;
      if (!operations.length && remoteRefreshPending) {
        remoteRefreshPending = false;
        emitTasks().catch(error => fail(error, "实时同步失败"));
      }
    }
  }

  async function upsertTasks(tasks) {
    const now = new Date().toISOString();
    const rows = tasks.map(task => ({
      workspace_id: workspace.id,
      id: task.id,
      data: task,
      updated_by: user.id,
      client_id: clientId,
      updated_at: now
    }));
    for (let index = 0; index < rows.length; index += 100) {
      const { error } = await client.from("tasks").upsert(rows.slice(index, index + 100));
      if (error) throw error;
    }
  }

  async function deleteTasks(ids) {
    if (!ids.length) return;
    const { error } = await client.from("tasks").delete().eq("workspace_id", workspace.id).in("id", ids);
    if (error) throw error;
  }

  async function replaceTasks(tasks) {
    const existing = await fetchTasks();
    const keep = new Set(tasks.map(task => task.id));
    await deleteTasks(existing.map(row => row.id).filter(id => !keep.has(id)));
    await upsertTasks(tasks);
  }

  async function signIn(signUp = false) {
    const form = $("#cloud-auth-form");
    if (!form.reportValidity()) return;
    const email = $("#cloud-email").value.trim();
    const password = $("#cloud-password").value;
    errorMessage = "";
    try {
      const { data, error } = signUp
        ? await client.auth.signUp({ email, password })
        : await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (signUp && !data.session) {
        callbacks.onError?.("账号已创建，请先完成邮箱验证，再返回登录");
        return;
      }
      user = data.user;
      await loadWorkspaces();
      callbacks.onError?.(signUp ? "账号创建成功" : "登录成功");
    } catch (error) {
      setError(error);
    }
  }

  async function createWorkspace() {
    const form = $("#cloud-create-form");
    if (!form.reportValidity()) return;
    try {
      const { data, error } = await client.rpc("create_workspace", { workspace_name: $("#cloud-workspace-name").value.trim() });
      if (error) throw error;
      memberships.push(data);
      await activateWorkspace(data);
      callbacks.onError?.("团队空间已创建，可以邀请协作者了");
    } catch (error) {
      setError(error);
    }
  }

  async function joinWorkspace() {
    const form = $("#cloud-join-form");
    if (!form.reportValidity()) return;
    try {
      const { data, error } = await client.rpc("join_workspace", { invite_code: $("#cloud-invite-code").value.trim() });
      if (error) throw error;
      if (!memberships.some(item => item.id === data.id)) memberships.push(data);
      await activateWorkspace(data);
      callbacks.onError?.(`已加入 ${data.name}`);
    } catch (error) {
      setError(error);
    }
  }

  async function handleSignedOut() {
    await unsubscribe();
    user = null;
    workspace = null;
    memberships = [];
    operations = [];
    switchingWorkspace = false;
    setMode("signedOut");
  }

  async function signOut() {
    if (operations.length || syncing) {
      callbacks.onError?.("仍有任务正在同步，请稍后再退出");
      return;
    }
    await client.auth.signOut();
    await handleSignedOut();
  }

  function canEdit() {
    return !workspace || ["owner", "editor"].includes(workspace.role);
  }

  function bindUI() {
    $("#collab-btn").addEventListener("click", () => {
      render();
      $("#cloud-dialog").showModal();
    });
    $("#close-cloud-dialog").addEventListener("click", () => $("#cloud-dialog").close());
    $("#cloud-dialog").addEventListener("click", event => {
      if (event.target === $("#cloud-dialog")) $("#cloud-dialog").close();
      const workspaceId = event.target.closest("[data-cloud-workspace]")?.dataset.cloudWorkspace;
      if (workspaceId) {
        const selected = memberships.find(item => item.id === workspaceId);
        if (selected) activateWorkspace(selected).catch(error => setError(error));
        return;
      }
      const action = event.target.closest("[data-cloud-action]")?.dataset.cloudAction;
      if (action === "sign-in") signIn(false);
      if (action === "sign-up") signIn(true);
      if (action === "sign-out") signOut().catch(error => setError(error));
      if (action === "copy-invite" && workspace) {
        navigator.clipboard.writeText(workspace.join_code)
          .then(() => callbacks.onError?.("邀请码已复制"))
          .catch(() => callbacks.onError?.(`邀请码：${workspace.join_code}`));
      }
      if (action === "switch-workspace") {
        switchingWorkspace = true;
        render();
      }
      if (action === "cancel-switch") {
        switchingWorkspace = false;
        render();
      }
      if (action === "refresh") emitTasks().then(() => callbacks.onError?.("已从云端刷新")).catch(error => setError(error));
    });
    $("#cloud-dialog").addEventListener("submit", event => {
      event.preventDefault();
      if (event.target.id === "cloud-auth-form") signIn(false);
      if (event.target.id === "cloud-create-form") createWorkspace();
      if (event.target.id === "cloud-join-form") joinWorkspace();
    });
  }

  function render() {
    const button = $("#collab-btn");
    const body = $("#cloud-dialog-body");
    if (!button || !body) return;
    button.classList.toggle("cloud-active", mode === "active");
    button.innerHTML = `<i></i><span>${mode === "active" && workspace ? esc(workspace.name) : configured ? "团队协作" : "本地模式"}</span>`;
    renderSaveState(syncing ? "syncing" : mode);
    if (mode === "unconfigured") body.innerHTML = renderUnconfigured();
    if (mode === "loading") body.innerHTML = `<div class="cloud-loading"><i></i><strong>正在连接团队空间</strong><p>加载账号、成员权限和云端任务…</p></div>`;
    if (mode === "signedOut") body.innerHTML = renderAuth();
    if (mode === "noWorkspace" || switchingWorkspace) body.innerHTML = renderWorkspaceChooser();
    if (mode === "active" && !switchingWorkspace && workspace) body.innerHTML = renderWorkspace();
    if (errorMessage) body.insertAdjacentHTML("beforeend", `<div class="cloud-error">${esc(errorMessage)}</div>`);
  }

  function renderUnconfigured() {
    return `<div class="cloud-setup"><span class="cloud-setup-icon">LOCAL</span><h3>当前是可离线使用的本地模式</h3><p>要开启公网多人协作，需要部署静态网站并连接 Supabase。现有任务和离线使用方式不会受影响。</p><ol><li>在 Supabase 新建项目，执行项目中的 <code>supabase/schema.sql</code>。</li><li>将 Project URL 和 anon public key 填入 <code>config.js</code>。</li><li>推送 GitHub 仓库并启用 Pages，通过 HTTPS 访问网站。</li></ol><div class="cloud-security">只需公开的 anon key。绝对不要在前端配置 service_role 密钥。</div><a href="https://github.com/supabase/supabase" target="_blank" rel="noreferrer">查看 Supabase 开源项目 →</a></div>`;
  }

  function renderAuth() {
    return `<div class="cloud-auth"><p class="cloud-lead">登录后可创建团队空间，或通过邀请码加入其他人的项目。</p><form id="cloud-auth-form"><label class="field full"><span>邮箱</span><input id="cloud-email" type="email" required autocomplete="email" placeholder="name@example.com"></label><label class="field full"><span>密码</span><input id="cloud-password" type="password" required minlength="6" autocomplete="current-password" placeholder="至少 6 位"></label><div class="cloud-actions"><button type="button" class="secondary-btn" data-cloud-action="sign-up">注册账号</button><button type="button" class="primary-btn" data-cloud-action="sign-in">登录并同步</button></div></form><p class="cloud-hint">注册可能需要邮箱验证，请在 Supabase Auth 设置中确认。</p></div>`;
  }

  function renderWorkspaceChooser() {
    return `<div class="workspace-chooser"><p class="cloud-lead">一个团队空间对应一套共享任务。创建后，把邀请码发给协作者即可。</p>${memberships.length ? `<div class="workspace-list">${memberships.map(item => `<button data-cloud-workspace="${esc(item.id)}"><strong>${esc(item.name)}</strong><span>${item.role === "owner" ? "所有者" : item.role === "viewer" ? "观察员" : "编辑者"}</span></button>`).join("")}</div>` : ""}<div class="workspace-forms"><form id="cloud-create-form"><h3>创建新空间</h3><label class="field full"><span>项目名称</span><input id="cloud-workspace-name" required maxlength="60" value="我的 UE5 游戏"></label><button class="primary-btn" type="submit">创建并初始化任务</button></form><form id="cloud-join-form"><h3>加入团队</h3><label class="field full"><span>邀请码</span><input id="cloud-invite-code" required minlength="6" placeholder="输入团队成员分享的邀请码"></label><button class="secondary-btn" type="submit">加入空间</button></form></div>${switchingWorkspace ? `<button class="text-btn cloud-cancel" data-cloud-action="cancel-switch">取消切换</button>` : ""}</div>`;
  }

  function renderWorkspace() {
    return `<div class="cloud-workspace"><div class="workspace-summary"><span class="workspace-avatar">${esc(workspace.name.slice(0, 1).toUpperCase())}</span><div><h3>${esc(workspace.name)}</h3><p>${esc(user?.email || "")} · ${workspace.role === "owner" ? "所有者" : workspace.role === "viewer" ? "观察员" : "编辑者"}</p></div><span class="online-badge"><i></i><b id="cloud-online-count">${onlineUsers.length}</b> 人在线</span></div><div class="invite-box"><span>团队邀请码</span><div><code>${esc(workspace.join_code)}</code><button class="secondary-btn" data-cloud-action="copy-invite">复制邀请码</button></div><p>协作者注册并登录后，输入此邀请码即可加入。邀请码等同于编辑权限，只分享给信任的团队成员。</p></div><div id="cloud-presence" class="cloud-presence">${renderOnlineUsers()}</div><div class="cloud-actions spread"><button class="secondary-btn" data-cloud-action="refresh">立即刷新</button><button class="secondary-btn" data-cloud-action="switch-workspace">切换 / 加入空间</button><button class="danger-btn" data-cloud-action="sign-out">退出登录</button></div>${!canEdit() ? `<div class="cloud-security">你是观察员，可以查看任务，但不能修改。</div>` : ""}</div>`;
  }

  function renderOnlineUsers() {
    if (!onlineUsers.length) return "正在获取在线成员…";
    return `<span>在线成员</span>${onlineUsers.map(item => `<div><i>${esc((item.email || "U").slice(0, 1).toUpperCase())}</i><span>${esc(item.email || item.user_id)}${item.user_id === user?.id ? "（你）" : ""}</span></div>`).join("")}`;
  }

  function renderPresence() {
    const count = $("#cloud-online-count");
    const presence = $("#cloud-presence");
    if (count) count.textContent = onlineUsers.length;
    if (presence) presence.innerHTML = renderOnlineUsers();
  }

  function renderSaveState(status) {
    const element = $("#save-state");
    if (!element) return;
    const labels = {
      unconfigured: "已保存到本地",
      loading: "正在连接云端…",
      signedOut: "云端未登录 · 本地可用",
      noWorkspace: "请选择团队空间",
      active: "团队任务已同步",
      syncing: "正在同步到云端…",
      error: "云端保存失败 · 自动重试"
    };
    element.innerHTML = `<i></i>${labels[status] || labels.unconfigured}`;
    element.classList.toggle("save-error", status === "error");
  }

  window.LumaCloud = { init, commit, canEdit, isActive: () => Boolean(workspace && user) };
})();
