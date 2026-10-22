window.__ModuleLoader__.load({
	id: "dsh-litgraph",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useMemo = React.useMemo;
		var useRef = React.useRef;
		var useCallback = React.useCallback;

		var API = "/api/dsh-litgraph";

		/* ----------------------------------------------------------- utilities */

		function cls() {
			return Array.prototype.slice.call(arguments).filter(Boolean).join(" ");
		}

		function api(path, body) {
			return fetch(API + path, {
				method: body === undefined ? "GET" : "POST",
				headers: body === undefined ? undefined : { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body)
			}).then(function (response) {
				if (!response.ok) throw new Error("HTTP " + response.status);
				return response.json();
			});
		}

		function fmt(n) {
			if (n === null || n === undefined || Number.isNaN(n)) return "—";
			if (n >= 10000) return (n / 1000).toFixed(1) + "k";
			return String(n);
		}

		function pct(value) {
			return Math.round((Number(value) || 0) * 100) + "%";
		}

		var DIMENSIONS = [
			["impact", "影响力", "#8b5cf6"],
			["venue", "载体", "#3b82f6"],
			["rigor", "严谨", "#14b8a6"],
			["evidence", "证据", "#f59e0b"],
			["novelty", "新颖", "#ec4899"],
			["reproducibility", "可复现", "#22c55e"]
		];

		var CLUSTER_COLORS = [
			"#6366f1", "#14b8a6", "#f59e0b", "#ec4899", "#3b82f6", "#a855f7",
			"#22c55e", "#ef4444", "#0ea5e9", "#eab308", "#f97316", "#8b5cf6"
		];

		/* --------------------------------------------------------------- store */

		var store = {
			open: false,
			tab: "search",
			query: "",
			mode: "balanced",
			limit: 30,
			yearFrom: "",
			yearTo: "",
			providers: ["openalex", "crossref", "semanticscholar", "arxiv"],
			snowball: true,
			status: null,
			loading: false,
			error: null,
			result: null,
			selected: null,
			review: null,
			reviewBusy: false,
			reviewError: null,
			reviewMode: "llm",
			notice: null,
			archives: null,
			archiveRoot: "",
			archiveWorkspace: "",
			workspace: "",
			workspaceList: null,
			archiveId: "",
			archiveTitle: "",
			archiveBusy: false,
			archiveError: null
		};

		var listeners = new Set();

		function emit() {
			listeners.forEach(function (listener) {
				try {
					listener();
				} catch (e) {
					/* a broken consumer must not stop the others */
				}
			});
		}

		function setState(patch) {
			var next = typeof patch === "function" ? patch(store) : patch;
			Object.assign(store, next);
			emit();
		}

		function useStore() {
			var pair = useState(0);
			var force = pair[1];
			useEffect(function () {
				var listener = function () {
					force(function (value) {
						return value + 1;
					});
				};
				listeners.add(listener);
				return function () {
					listeners.delete(listener);
				};
			}, []);
			return store;
		}

		function notice(text, kind) {
			setState({ notice: { text: text, kind: kind || "ok", at: Date.now() } });
			setTimeout(function () {
				if (store.notice && text === store.notice.text) setState({ notice: null });
			}, 3600);
		}

		/* ------------------------------------------------------------- actions */

		function ensureStatus() {
			if (store.status) return Promise.resolve(store.status);
			return api("/status")
				.then(function (status) {
					setState({
						status: status,
						providers: status.config && status.config.providers ? status.config.providers : store.providers,
						yearFrom: status.config && status.config.yearFrom ? String(status.config.yearFrom) : "",
						yearTo: status.config && status.config.yearTo ? String(status.config.yearTo) : ""
					});
					return status;
				})
				.catch(function (error) {
					setState({ error: "无法连接宿主：" + error.message });
					return null;
				});
		}

		function runSearch(force) {
			var query = store.query.trim();
			if (query.length < 2) {
				notice("请输入至少 2 个字符的研究主题", "err");
				return;
			}
			setState({ loading: true, error: null, review: null, reviewError: null });
			api("/search", {
				query: query,
				mode: store.mode,
				limit: store.limit,
				yearFrom: store.yearFrom ? Number(store.yearFrom) : undefined,
				yearTo: store.yearTo ? Number(store.yearTo) : undefined,
				providers: store.providers,
				snowball: store.snowball,
				force: Boolean(force)
			})
				.then(function (payload) {
					if (!payload.ok) throw new Error(payload.error || "检索失败");
					setState({
						result: payload,
						loading: false,
						selected: payload.papers && payload.papers[0] ? payload.papers[0].key : null,
						tab: payload.papers && payload.papers.length > 0 ? "graph" : "search"
					});
					try {
						window.localStorage.setItem("dsh-litgraph:last", query);
					} catch (e) {
						/* private mode */
					}
				})
				.catch(function (error) {
					setState({ loading: false, error: error.message });
				});
		}

		function runReview(useLlm) {
			var query = store.query.trim();
			if (query.length < 2) {
				notice("请先输入研究主题", "err");
				return;
			}
			setState({ reviewBusy: true, reviewError: null, review: null, tab: "review" });
			api("/review", {
				query: query,
				mode: store.mode,
				limit: store.limit,
				yearFrom: store.yearFrom ? Number(store.yearFrom) : undefined,
				yearTo: store.yearTo ? Number(store.yearTo) : undefined,
				providers: store.providers,
				snowball: store.snowball,
				useLlm: useLlm !== false
			})
				.then(function (payload) {
					if (!payload.ok) throw new Error(payload.error || "生成失败");
					setState({
						review: payload,
						reviewBusy: false,
						reviewMode: payload.mode,
						result: store.result || { papers: [], graph: payload.graph, stats: payload.stats, query: payload.query }
					});
					if (payload.llm && payload.llm.ok === false) {
						notice("模型不可用，已回退为启发式综述：" + (payload.llm.error || ""), "warn");
					}
				})
				.catch(function (error) {
					setState({ reviewBusy: false, reviewError: error.message });
				});
		}

		function saveConfig(patch) {
			return api("/config", patch)
				.then(function (payload) {
					if (!payload.ok) throw new Error(payload.error || "保存失败");
					setState({ status: Object.assign({}, store.status, { config: payload.config }) });
					notice(payload.saved === false ? "已应用（未能写入磁盘：" + payload.error + "）" : "配置已保存");
					if (patch && Object.prototype.hasOwnProperty.call(patch, "workspace")) loadArchives();
				})
				.catch(function (error) {
					notice("保存失败：" + error.message, "err");
				});
		}

		/* ------------------------------------------------------------ archives */

		function workspaceQuery() {
			var chosen = store.workspace;
			return typeof chosen === "string" && chosen ? "?workspace=" + encodeURIComponent(chosen) : "";
		}

		/** Known workspaces come from the host registry, so the panel never asks
		 *  the user to type a path. A manual override still wins when set. */
		function loadWorkspaces() {
			return api("/workspaces")
				.then(function (payload) {
					if (!payload.ok) throw new Error(payload.error || "读取工作区失败");
					var list = Array.isArray(payload.workspaces) ? payload.workspaces : [];
					var current = store.workspace;
					var pinned = store.status && store.status.config && store.status.config.workspace;
					if (typeof pinned === "string" && pinned && !current) current = pinned;
					if (!current) current = payload.current || (list[0] && list[0].path) || "";
					var known = list.some(function (row) { return row.path === current; });
					if (current && !known) {
						list = list.concat([{ id: "", path: current, title: current.split(/[\\/]/).filter(Boolean).pop() || current }]);
					}
					setState({ workspaceList: list, workspace: current });
					return list;
				})
				.catch(function (error) {
					setState({ workspaceList: [], archiveError: error.message });
					return [];
				});
		}

		function selectWorkspace(path) {
			setState({ workspace: path, archives: null, archiveId: "", archiveRoot: "" });
			return loadArchives();
		}

		/** Re-scan the selected workspace: registry list, archive index, then the
		 *  listing itself. This is the manual refresh the panel exposes. */
		function refreshArchives() {
			setState({ archiveError: null });
			return loadWorkspaces().then(function () {
				return loadArchives();
			});
		}

		function applyArchiveListing(payload) {
			setState({
				archives: payload.archives || [],
				archiveRoot: payload.root || "",
				archiveWorkspace: payload.workspace || "",
				archiveError: null
			});
		}

		function loadArchives() {
			setState({ archiveError: null });
			return ensureStatus()
				.then(function () {
					if (!store.workspaceList) return loadWorkspaces();
					return null;
				})
				.then(function () {
					return api("/archives" + workspaceQuery())
						.then(function (payload) {
							if (!payload.ok) throw new Error(payload.error || "读取档案失败");
							applyArchiveListing(payload);
							if (!store.archiveId && payload.archives && payload.archives.length > 0) {
								setState({ archiveId: payload.archives[payload.archives.length - 1].id });
							}
							return payload;
						});
				})
				.catch(function (error) {
					setState({ archiveError: error.message });
				});
		}

		function createArchive() {
			var query = store.query.trim();
			var title = (store.archiveTitle || "").trim() || query || "文献综述";
			setState({ archiveBusy: true, archiveError: null });
			api("/archives/create", { title: title, query: query, workspace: store.workspace || undefined })
				.then(function (payload) {
					if (!payload.ok) throw new Error(payload.error || "新建档案失败");
					setState({ archiveBusy: false, archiveId: payload.archive.id });
					notice("已新建档案 " + payload.archive.id);
					loadArchives();
				})
				.catch(function (error) {
					setState({ archiveBusy: false, archiveError: error.message });
					notice("新建档案失败：" + error.message, "err");
				});
		}

		function saveToArchive() {
			var query = store.query.trim();
			if (!query) {
				notice("先检索一个主题再保存", "err");
				return;
			}
			var markdown = store.review && store.review.markdown ? store.review.markdown : undefined;
			setState({ archiveBusy: true, archiveError: null });
			api("/archives/save", {
				archiveId: store.archiveId || undefined,
				workspace: store.workspace || undefined,
				title: (store.archiveTitle || "").trim() || query,
				query: query,
				mode: store.mode,
				limit: store.limit,
				yearFrom: store.yearFrom ? Number(store.yearFrom) : undefined,
				yearTo: store.yearTo ? Number(store.yearTo) : undefined,
				providers: store.providers,
				snowball: store.snowball,
				useLlm: false,
				markdown: markdown
			})
				.then(function (payload) {
					if (!payload.ok) throw new Error(payload.error || "保存失败");
					setState({ archiveBusy: false, archiveId: payload.archive.id });
					notice("已写入 " + payload.archive.id + "（" + payload.archive.paperCount + " 篇）");
					loadArchives();
				})
				.catch(function (error) {
					setState({ archiveBusy: false, archiveError: error.message });
					notice("保存档案失败：" + error.message, "err");
				});
		}

		function openArchive(id) {
			if (!id) {
				notice("先选择一个档案", "err");
				return;
			}
			setState({ archiveBusy: true, archiveError: null });
			api("/archives/read", { archiveId: id, workspace: store.workspace || undefined })
				.then(function (payload) {
					if (!payload.ok) throw new Error(payload.error || "读取失败");
					var markdown = payload.markdown || "";
					var meta = payload.meta || {};
					var sections = (markdown.match(/^## .+$/gm) || []).map(function (line) {
						return line.replace(/^## /, "");
					});
					var papers = Array.isArray(payload.papers) ? payload.papers : [];
					var graph = payload.graph || null;
					/* Rebuild the检索/图谱 state from the archive snapshot, so loading an
					 * archive restores the corpus everywhere and not only the prose. */
					var result = papers.length > 0
						? {
							ok: true,
							query: meta.query || store.query,
							mode: meta.mode || "archive",
							providers: meta.providers || [],
							yearFrom: meta.yearFrom,
							yearTo: meta.yearTo,
							stats: meta.stats || {},
							log: [],
							papers: papers,
							graph: graph,
							archiveId: meta.id || id
						}
						: store.result;
					setState({
						archiveBusy: false,
						archiveId: meta.id || id,
						query: meta.query || store.query,
						result: result,
						selected: papers.length > 0 && papers[0] ? papers[0].key : store.selected,
						review: {
							markdown: markdown,
							sections: sections,
							mode: "archive",
							llm: null
						},
						reviewError: null,
						tab: "review"
					});
					notice(
						papers.length > 0
							? "已载入档案 " + (meta.title || id) + "（" + papers.length + " 篇已同步到检索与图谱）"
							: "已载入档案 " + (meta.title || id) + "（该档案没有题录快照）"
					);
				})
				.catch(function (error) {
					setState({ archiveBusy: false, archiveError: error.message });
					notice("读取档案失败：" + error.message, "err");
				});
		}

		function exportMarkdown() {
			var markdown = store.review && store.review.markdown;
			if (!markdown) {
				notice("还没有可导出的综述", "err");
				return;
			}
			var blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
			var url = URL.createObjectURL(blob);
			var anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = "literature-review-" + store.query.replace(/[^\w\u4e00-\u9fff-]+/g, "_").slice(0, 48) + ".md";
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
			notice("已导出 Markdown");
		}

		function copyMarkdown() {
			var markdown = store.review && store.review.markdown;
			if (!markdown) return;
			var done = function () {
				notice("综述已复制到剪贴板");
			};
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(markdown).then(done, function () {
					notice("复制失败", "err");
				});
				return;
			}
			notice("当前环境不支持剪贴板", "err");
		}

		/* --------------------------------------------------------------- styles */

		var CSS = [
			".lg-root{position:fixed;inset:0;z-index:60;display:flex;align-items:stretch;justify-content:center;}",
			".lg-backdrop{position:absolute;inset:0;background:rgba(6,8,12,.62);backdrop-filter:blur(3px);}",
			".lg-panel{position:relative;margin:18px;flex:1;max-width:1500px;display:flex;flex-direction:column;min-height:0;",
			"border-radius:16px;overflow:hidden;background:#0f1117;color:#e6e8ee;border:1px solid rgba(255,255,255,.09);",
			"box-shadow:0 32px 80px rgba(0,0,0,.55);font-size:13px;line-height:1.55;font-family:inherit;}",
			".lg-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.08);",
			"background:linear-gradient(180deg,rgba(99,102,241,.14),rgba(99,102,241,0));}",
			".lg-tabs{display:flex;gap:2px;padding:6px 16px;border-bottom:1px solid rgba(255,255,255,.08);align-items:center;flex-wrap:wrap;}",
			".lg-tab{appearance:none;border:0;background:transparent;color:#9aa0ae;padding:6px 12px;border-radius:8px;cursor:pointer;",
			"font:inherit;font-size:12.5px;transition:background .15s,color .15s;}",
			".lg-tab:hover{background:rgba(255,255,255,.06);color:#dfe3ec;}",
			".lg-tab.on{background:rgba(99,102,241,.22);color:#c7cbff;}",
			".lg-body{flex:1;min-height:0;display:flex;overflow:hidden;}",
			".lg-scroll{overflow:auto;min-height:0;}",
			".lg-scroll::-webkit-scrollbar{width:9px;height:9px;}",
			".lg-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:8px;}",
			".lg-input,.lg-select{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:inherit;",
			"border-radius:8px;padding:7px 10px;font:inherit;outline:none;}",
			".lg-input:focus,.lg-select:focus{border-color:rgba(99,102,241,.7);}",
			".lg-btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:inherit;",
			"padding:6px 12px;border-radius:8px;font:inherit;font-size:12.5px;cursor:pointer;transition:background .15s,border-color .15s;}",
			".lg-btn:hover{background:rgba(255,255,255,.1);}",
			".lg-btn.primary{background:#4f46e5;border-color:#4f46e5;color:#fff;}",
			".lg-btn.primary:hover{background:#4338ca;}",
			".lg-btn:disabled{opacity:.45;cursor:default;}",
			".lg-card{border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:12px 14px;background:rgba(255,255,255,.025);",
			"transition:border-color .15s,background .15s;}",
			".lg-card:hover{border-color:rgba(99,102,241,.45);background:rgba(99,102,241,.07);}",
			".lg-card.sel{border-color:#6366f1;background:rgba(99,102,241,.12);}",
			".lg-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;",
			"background:rgba(255,255,255,.08);color:#b8becd;font-size:11px;white-space:nowrap;}",
			".lg-node{cursor:pointer;}",
			".lg-node circle{transition:r .15s,stroke-width .15s;}",
			".lg-md{max-width:860px;margin:0 auto;padding:26px 30px 60px;}",
			".lg-md h1{font-size:22px;margin:0 0 14px;line-height:1.35;}",
			".lg-md h2{font-size:16px;margin:26px 0 10px;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,.09);}",
			".lg-md h3{font-size:14px;margin:18px 0 8px;color:#c9cee0;}",
			".lg-md p{margin:8px 0;}",
			".lg-md ul,.lg-md ol{margin:8px 0;padding-left:22px;}",
			".lg-md li{margin:4px 0;}",
			".lg-md code{background:rgba(255,255,255,.09);padding:1px 5px;border-radius:5px;font-size:12px;}",
			".lg-md pre{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:10px;",
			"padding:12px 14px;overflow:auto;font-size:12px;line-height:1.5;}",
			".lg-md pre code{background:none;padding:0;}",
			".lg-md blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid rgba(99,102,241,.7);",
			"background:rgba(99,102,241,.08);border-radius:0 8px 8px 0;color:#b9c0d4;}",
			".lg-md table{border-collapse:collapse;margin:12px 0;width:100%;font-size:12.5px;}",
			".lg-md th,.lg-md td{border:1px solid rgba(255,255,255,.1);padding:6px 9px;text-align:left;vertical-align:top;}",
			".lg-md th{background:rgba(255,255,255,.06);font-weight:600;}",
			".lg-md a{color:#8b9dff;}",
			".lg-md hr{border:0;border-top:1px solid rgba(255,255,255,.1);margin:20px 0;}",
			".lg-spin{width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#a5b4fc;",
			"border-radius:50%;animation:lgspin .8s linear infinite;display:inline-block;vertical-align:-2px;}",
			"@keyframes lgspin{to{transform:rotate(360deg)}}",
			".lg-launch{display:flex!important;align-items:center;gap:10px;width:100%;box-sizing:border-box;text-align:left;",
			"border:0!important;background:transparent!important;box-shadow:none!important;color:inherit!important;",
			"border-radius:8px;padding:6px 10px!important;margin:0;font:inherit!important;font-size:13px!important;",
			"line-height:1.45;min-height:0;cursor:pointer;opacity:.8;transition:background .15s,opacity .15s;}",
			".lg-launch:hover{background:rgba(127,127,127,.16)!important;opacity:1;}",
			".lg-launch.on{background:rgba(127,127,127,.13)!important;opacity:1;}",
			".lg-launch:focus-visible{outline:1px solid rgba(99,102,241,.75);outline-offset:1px;}",
			".lg-launch svg{flex:0 0 auto;opacity:.92;}",
			".lg-launch span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
			/* The slot wraps each footer action in its own cell, and that cell draws the
			 * pill-looking border the shipped rows do not have. Neutralise it so our
			 * row matches its neighbours instead of looking like a foreign button. */
			"*:has(> .lg-launch){background:transparent!important;border:0!important;",
			"box-shadow:none!important;border-radius:8px!important;padding:0!important;}",
			".lg-scroll-x{overflow-x:auto;}",
			".lg-meter{height:4px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden;}",
			".lg-meter>span{display:block;height:100%;border-radius:999px;}"
		].join("");

		/* ---------------------------------------------------------- score bars */

		function ScoreBars(props) {
			var scores = props.scores || {};
			return h(
				"div",
				{ style: { display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" } },
				DIMENSIONS.map(function (entry) {
					var value = scores[entry[0]] || 0;
					return h(
						"div",
						{ key: entry[0], style: { minWidth: 64, flex: "0 0 auto" }, title: entry[1] + " " + pct(value) },
						h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 10.5, opacity: 0.7 } }, h("span", null, entry[1]), h("span", null, pct(value))),
						h("div", { className: "lg-meter", style: { marginTop: 2 } }, h("span", { style: { width: pct(value), background: entry[2] } }))
					);
				})
			);
		}

		/* ------------------------------------------------------------- launcher */

		function Launcher(props) {
			var state = useStore();
			var wide = !(props && props.wide === false);
			var onOpen = useCallback(function () {
				setState({ open: true, tab: state.result ? state.tab : "search" });
				ensureStatus();
				try {
					var last = window.localStorage.getItem("dsh-litgraph:last");
					if (last && !store.query) setState({ query: last });
				} catch (e) {
					/* ignore */
				}
			}, []);
			return h(
				"button",
				{ className: cls("lg-launch", state.open && "on"), onClick: onOpen, title: "AI 文献发现与综述（dsh-litgraph）" },
				h(
					"svg",
					{ width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
					h("circle", { cx: 11, cy: 11, r: 7 }),
					h("path", { d: "M20 20l-3.5-3.5" }),
					h("path", { d: "M11 8v6M8 11h6" })
				),
				wide ? h("span", null, "文献发现") : null
			);
		}

		/* --------------------------------------------------------- search tab */

		function SearchPane() {
			var state = useStore();
			var providers = state.status && state.status.config ? state.status.config.providers : state.providers;
			var allProviders = (state.status && state.status.providers) || ["openalex", "crossref", "semanticscholar", "arxiv"];
			var toggleProvider = function (id) {
				var next = state.providers.indexOf(id) >= 0 ? state.providers.filter(function (x) { return x !== id; }) : state.providers.concat([id]);
				setState({ providers: next.length > 0 ? next : [id] });
			};
			return h(
				"div",
				{ className: "lg-scroll", style: { flex: 1, padding: "18px 20px 40px" } },
				h(
					"div",
					{ style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
					h("input", {
						className: "lg-input",
						style: { flex: "1 1 320px", fontSize: 14, padding: "10px 12px" },
						placeholder: "研究主题 / 关键词，例如：multi-agent coordination, protein folding, 碳捕集",
						value: state.query,
						onChange: function (event) {
							setState({ query: event.target.value });
						},
						onKeyDown: function (event) {
							if (event.key === "Enter") runSearch(true);
						}
					}),
					h(
						"select",
						{
							className: "lg-select",
							value: state.mode,
							onChange: function (event) {
								setState({ mode: event.target.value });
							}
						},
						h("option", { value: "focused" }, "聚焦"),
						h("option", { value: "balanced" }, "均衡"),
						h("option", { value: "broad" }, "广域")
					),
					h(
						"button",
						{ className: "lg-btn primary", disabled: state.loading, onClick: function () { runSearch(true); } },
						state.loading ? h("span", { style: { display: "inline-flex", gap: 6, alignItems: "center" } }, h("span", { className: "lg-spin" }), "检索中") : "检索"
					)
				),
				h(
					"div",
					{ style: { display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", marginTop: 12, fontSize: 12, color: "#9aa0ae" } },
					h(
						"div",
						{ style: { display: "flex", gap: 6, flexWrap: "wrap" } },
						allProviders.map(function (id) {
							var on = state.providers.indexOf(id) >= 0;
							return h(
								"button",
								{
									key: id,
									className: "lg-btn",
									style: on ? { borderColor: "rgba(99,102,241,.7)", color: "#c7cbff", background: "rgba(99,102,241,.16)" } : { opacity: 0.6 },
									onClick: function () {
										toggleProvider(id);
									}
								},
								id
							);
						})
					),
					h("span", { style: { opacity: 0.5 } }, "|"),
					h("label", { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
						"年份",
						h("input", { className: "lg-input", style: { width: 62, padding: "4px 6px" }, placeholder: "从", value: state.yearFrom, onChange: function (e) { setState({ yearFrom: e.target.value }); } }),
						h("span", null, "–"),
						h("input", { className: "lg-input", style: { width: 62, padding: "4px 6px" }, placeholder: "至", value: state.yearTo, onChange: function (e) { setState({ yearTo: e.target.value }); } })
					),
					h("label", { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
						"每源条数",
						h("input", { className: "lg-input", type: "range", min: 10, max: 60, step: 5, style: { width: 110, padding: 0 }, value: state.limit, onChange: function (e) { setState({ limit: Number(e.target.value) }); } }),
						h("span", null, state.limit)
					),
					h("label", { style: { display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" } },
						h("input", { type: "checkbox", checked: state.snowball, onChange: function (e) { setState({ snowball: e.target.checked }); } }),
						"引文滚雪球"
					),
					providers && providers.join(",") !== allProviders.join(",")
						? h("span", { className: "lg-badge" }, "默认源：" + providers.join(" / "))
						: null
				),
				state.error ? h("div", { style: { marginTop: 14, color: "#fca5a5" } }, state.error) : null,
				state.result && state.result.papers && state.result.papers.length > 0 ? renderResults(state) : h(EmptyHint)
			);
		}

		function EmptyHint() {
			var state = useStore();
			if (state.loading) return null;
			return h(
				"div",
				{ style: { marginTop: 28, color: "#8b91a1", fontSize: 13, lineHeight: 1.9 } },
				h("div", { style: { fontSize: 15, color: "#c9cee0", marginBottom: 8 } }, "从一个问题开始"),
				h("div", null, "插件会并行查询 OpenAlex、Crossref、Semantic Scholar 与 arXiv，按 DOI / 标题去重，再从六个维度打分排序："),
				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0 16px" } },
					DIMENSIONS.map(function (entry) {
						return h("span", { key: entry[0], className: "lg-badge", style: { color: entry[2] } }, entry[1]);
					})
				),
				h("div", null, "检索后切换到「图谱」查看主题簇与引用结构，「综述」一键生成结构化文献综述（模型可用时由模型撰写，否则走确定性合成）。"),
				h("div", { style: { marginTop: 10, opacity: 0.7 } }, "提示：按 Enter 直接检索；Esc 关闭面板。")
			);
		}

		function renderResults(state) {
			var result = state.result;
			var stats = result.stats || {};
			return h(
				"div",
				{ style: { marginTop: 20 } },
				h(
					"div",
					{ style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12, fontSize: 12, color: "#9aa0ae" } },
					h("span", { className: "lg-badge", style: { background: "rgba(99,102,241,.2)", color: "#c7cbff" } }, result.papers.length + " 篇"),
					h("span", null, "去重 " + (stats.duplicatesRemoved || 0)),
					h("span", null, "有摘要 " + (stats.withAbstract || 0)),
					h("span", null, "开放获取 " + (stats.openAccess || 0)),
					h("span", null, "年份 " + (stats.yearMin || "?") + "–" + (stats.yearMax || "?")),
					h("span", { style: { opacity: 0.6 } }, result.cached ? "（缓存命中）" : ""),
					h("span", { style: { marginLeft: "auto", display: "flex", gap: 8 } },
						h("button", { className: "lg-btn", onClick: function () { setState({ tab: "graph" }); } }, "图谱"),
						h("button", { className: "lg-btn primary", onClick: function () { runReview(true); } }, "生成综述")
					)
				),
				(result.log || []).filter(function (entry) { return entry.ok === false; }).length > 0
					? h("div", { style: { fontSize: 11.5, color: "#fbbf24", marginBottom: 10 } },
						"部分数据源不可用：" +
							(result.log || [])
								.filter(function (entry) { return entry.ok === false; })
								.map(function (entry) { return entry.provider + "（" + (entry.error || "失败") + "）"; })
								.join("；"))
					: null,
				h(
					"div",
					{ style: { display: "grid", gap: 10 } },
					result.papers.map(function (paper) {
						var selected = state.selected === paper.key;
						return h(
							"div",
							{
								key: paper.id,
								className: cls("lg-card", selected && "sel"),
								style: { cursor: "pointer" },
								onClick: function () {
									setState({ selected: paper.key });
									if (state.tab !== "search") setState({ tab: "graph" });
								}
							},
							h(
								"div",
								{ style: { display: "flex", gap: 10, alignItems: "baseline" } },
								h("span", { className: "lg-badge", style: { background: "rgba(99,102,241,.22)", color: "#c7cbff" } }, paper.key),
								h("span", { style: { fontWeight: 600, flex: 1, lineHeight: 1.45 } }, paper.title || "(无标题)"),
								h("span", { className: "lg-badge", title: "六维综合分" }, paper.composite.toFixed(2))
							),
							h(
								"div",
								{ style: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6, fontSize: 11.5, color: "#98a0b3" } },
								h("span", null, paper.year || "n.d."),
								h("span", null, paper.venue || "未注明载体"),
								h("span", null, (paper.authors || []).slice(0, 3).join(", ") + ((paper.authors || []).length > 3 ? " 等" : "")),
								h("span", null, "被引 " + fmt(paper.citedBy)),
								paper.openAccess ? h("span", { style: { color: "#34d399" } }, "OA") : null,
								(paper.sources || [paper.source]).map(function (source) {
									return h("span", { key: source, className: "lg-badge" }, source);
								})
							),
							paper.abstract
								? h("div", { style: { marginTop: 8, fontSize: 12, color: "#b6bccb", lineHeight: 1.6, maxHeight: selected ? 260 : 46, overflow: "hidden" } }, paper.abstract)
								: h("div", { style: { marginTop: 8, fontSize: 11.5, color: "#6b7280" } }, "（无摘要，仅题录信息）"),
							selected ? h(ScoreBars, { scores: paper.scores }) : null,
							h(
								"div",
								{ style: { display: "flex", gap: 10, marginTop: 8, fontSize: 11.5 } },
								paper.doi ? h("a", { href: "https://doi.org/" + paper.doi, target: "_blank", rel: "noreferrer", style: { color: "#8b9dff" } }, "doi:" + paper.doi) : null,
								paper.url && !paper.doi ? h("a", { href: paper.url, target: "_blank", rel: "noreferrer", style: { color: "#8b9dff" } }, "原文链接") : null
							)
						);
					})
				)
			);
		}

		/* ---------------------------------------------------------- graph tab */

		/* Deterministic layout: the same corpus must always produce the same
		 * picture, otherwise switching tabs or resizing the window reshuffles
		 * every node ("the graph flies around"). */
		var layoutCache = new WeakMap();

		function hashSeed(text) {
			var hash = 2166136261;
			for (var i = 0; i < text.length; i += 1) {
				hash ^= text.charCodeAt(i);
				hash = Math.imul(hash, 16777619);
			}
			return hash >>> 0;
		}

		function seededRandom(seed) {
			var state = seed || 1;
			return function () {
				state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
				return state / 4294967296;
			};
		}

		function layoutGraph(graph) {
			var source = graph && graph.nodes ? graph.nodes : [];
			var rand = seededRandom(hashSeed(source.map(function (node) { return node.id; }).join("|") || "litgraph"));
			var nodes = source.map(function (node, index, all) {
				var angle = (index / Math.max(1, all.length)) * Math.PI * 2;
				return {
					id: node.id,
					x: Math.cos(angle) * 240 + (rand() - 0.5) * 40,
					y: Math.sin(angle) * 240 + (rand() - 0.5) * 40,
					vx: 0,
					vy: 0,
					node: node
				};
			});
			var byId = new Map(nodes.map(function (entry) { return [entry.id, entry]; }));
			var links = (graph && graph.edges ? graph.edges : [])
				.map(function (edge) {
					var from = byId.get(edge.source);
					var to = byId.get(edge.target);
					return from && to ? { from: from, to: to, weight: edge.weight || 1 } : null;
				})
				.filter(Boolean);
			var iterations = 320;
			for (var step = 0; step < iterations; step += 1) {
				var alpha = 1 - step / iterations;
				for (var i = 0; i < nodes.length; i += 1) {
					for (var j = i + 1; j < nodes.length; j += 1) {
						var a = nodes[i];
						var b = nodes[j];
						var dx = b.x - a.x;
						var dy = b.y - a.y;
						var distanceSq = dx * dx + dy * dy + 0.01;
						var distance = Math.sqrt(distanceSq);
						var force = 3200 / distanceSq;
						var fx = (dx / distance) * force;
						var fy = (dy / distance) * force;
						a.vx -= fx;
						a.vy -= fy;
						b.vx += fx;
						b.vy += fy;
					}
				}
				links.forEach(function (link) {
					var dx = link.to.x - link.from.x;
					var dy = link.to.y - link.from.y;
					var distance = Math.sqrt(dx * dx + dy * dy) + 0.01;
					var target = 170 / Math.max(1, link.weight * 0.6);
					var force = (distance - target) * 0.012 * link.weight;
					var fx = (dx / distance) * force;
					var fy = (dy / distance) * force;
					link.from.vx += fx;
					link.from.vy += fy;
					link.to.vx -= fx;
					link.to.vy -= fy;
				});
				nodes.forEach(function (entry) {
					entry.vx -= entry.x * 0.0022;
					entry.vy -= entry.y * 0.0022;
					entry.x += entry.vx * alpha * 0.9;
					entry.y += entry.vy * alpha * 0.9;
					entry.vx *= 0.72;
					entry.vy *= 0.72;
				});
			}
			return { nodes: nodes, links: links };
		}

		function GraphPane() {
			var state = useStore();
			var graph = state.result && state.result.graph;
			var viewport = useState({ x: 0, y: 0, k: 1 });
			var transform = viewport[0];
			var setTransform = viewport[1];
			var dragRef = useRef(null);
			var svgRef = useRef(null);
			var transformRef = useRef(transform);
			transformRef.current = transform;
			var layout = useMemo(function () {
				if (!graph || !graph.nodes || graph.nodes.length === 0) return { nodes: [], links: [] };
				var cached = layoutCache.get(graph);
				if (cached) return cached;
				var next = layoutGraph(graph);
				layoutCache.set(graph, next);
				return next;
			}, [graph]);
			useEffect(function () {
				setTransform({ x: 0, y: 0, k: 1 });
			}, [graph]);
			var geometry = useMemo(function () {
				if (!graph || !graph.nodes || graph.nodes.length === 0) return null;
				var points = layout.nodes;
				if (!points || points.length === 0) return null;
				var radius = points.map(function (entry) {
					return Math.max(6, Math.min(22, 5 + Math.sqrt((entry.node.citedBy || 0) + 1) * 1.5 + (entry.node.score || 0) * 6));
				});
				var minX = Math.min.apply(null, points.map(function (entry) { return entry.x; }));
				var maxX = Math.max.apply(null, points.map(function (entry) { return entry.x; }));
				var minY = Math.min.apply(null, points.map(function (entry) { return entry.y; }));
				var maxY = Math.max.apply(null, points.map(function (entry) { return entry.y; }));
				var pad = 80;
				return {
					nodes: points,
					radius: radius,
					viewBox: [minX - pad, minY - pad, Math.max(320, maxX - minX + pad * 2), Math.max(320, maxY - minY + pad * 2)]
				};
			}, [graph, layout]);
			useEffect(function () {
				var svg = svgRef.current;
				if (!svg || !geometry) return;
				var box = geometry.viewBox;
				var onWheel = function (event) {
					event.preventDefault();
					var rect = svg.getBoundingClientRect();
					if (!rect.width || !rect.height) return;
					var scale = Math.min(rect.width / box[2], rect.height / box[3]);
					if (!scale) return;
					var offsetX = (rect.width - box[2] * scale) / 2;
					var offsetY = (rect.height - box[3] * scale) / 2;
					var px = box[0] + (event.clientX - rect.left - offsetX) / scale;
					var py = box[1] + (event.clientY - rect.top - offsetY) / scale;
					var current = transformRef.current || { x: 0, y: 0, k: 1 };
					var delta = event.deltaY || 0;
					if (!delta) return;
					var factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0016));
					var nextK = Math.max(0.2, Math.min(12, (current.k || 1) * factor));
					var ratio = nextK / (current.k || 1);
					setTransform({
						x: px - (px - current.x) * ratio,
						y: py - (py - current.y) * ratio,
						k: nextK
					});
				};
				svg.addEventListener("wheel", onWheel, { passive: false });
				return function () { svg.removeEventListener("wheel", onWheel); };
			}, [geometry]);
			var zoomBy = function (factor) {
				var current = transformRef.current || { x: 0, y: 0, k: 1 };
				var nextK = Math.max(0.2, Math.min(12, (current.k || 1) * factor));
				var ratio = nextK / (current.k || 1);
				var cx = geometry.viewBox[0] + geometry.viewBox[2] / 2;
				var cy = geometry.viewBox[1] + geometry.viewBox[3] / 2;
				setTransform({
					x: cx - (cx - current.x) * ratio,
					y: cy - (cy - current.y) * ratio,
					k: nextK
				});
			};
			if (!geometry) {
				return h(
					"div",
					{ style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#8b91a1" } },
					state.loading ? h("span", { style: { display: "inline-flex", gap: 8, alignItems: "center" } }, h("span", { className: "lg-spin" }), "正在构建图谱…") : "先检索，再查看知识图谱"
				);
			}
			var nodes = geometry.nodes;
			var radius = geometry.radius;
			var viewBox = geometry.viewBox;
			var selectedNode = nodes.filter(function (entry) { return entry.node.key === state.selected; })[0];
			var timeline = graph.timeline || [];
			var maxYearCount = timeline.reduce(function (max, entry) { return Math.max(max, entry.count); }, 1);
			var startDrag = function (event) {
				dragRef.current = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y };
			};
			var onMove = function (event) {
				if (!dragRef.current) return;
				setTransform({
					x: dragRef.current.tx + (event.clientX - dragRef.current.x),
					y: dragRef.current.ty + (event.clientY - dragRef.current.y),
					k: transform.k
				});
			};
			var endDrag = function () {
				dragRef.current = null;
			};
			return h(
				"div",
				{ style: { flex: 1, display: "flex", minHeight: 0 } },
				h(
					"div",
					{ style: { flex: 1, position: "relative", minWidth: 0, background: "radial-gradient(circle at 50% 40%,rgba(99,102,241,.13),transparent 65%)" } },
					h(
						"svg",
						{
							ref: svgRef,
							viewBox: viewBox.join(" "),
							style: { width: "100%", height: "100%", cursor: dragRef.current ? "grabbing" : "grab", display: "block", touchAction: "none" },
							onMouseDown: startDrag,
							onMouseMove: onMove,
							onMouseUp: endDrag,
							onMouseLeave: endDrag
						},
						h(
							"g",
							{ transform: "translate(" + transform.x + "," + transform.y + ") scale(" + transform.k + ")" },
							layout.links.map(function (link, index) {
								var highlight = selectedNode && (link.from.node.key === state.selected || link.to.node.key === state.selected);
								return h("line", {
									key: "e" + index,
									x1: link.from.x,
									y1: link.from.y,
									x2: link.to.x,
									y2: link.to.y,
									stroke: highlight ? "rgba(199,203,255,.85)" : "rgba(148,163,184,.22)",
									strokeWidth: highlight ? 1.8 : Math.min(2.2, 0.5 + link.weight * 0.35)
								});
							}),
							nodes.map(function (entry, index) {
								var node = entry.node;
								var isSelected = node.key === state.selected;
								var color = CLUSTER_COLORS[node.cluster % CLUSTER_COLORS.length];
								return h(
									"g",
									{
										key: node.id,
										className: "lg-node",
										onClick: function (event) {
											event.stopPropagation();
											setState({ selected: node.key });
										}
									},
									h("circle", {
										cx: entry.x,
										cy: entry.y,
										r: radius[index] + (isSelected ? 3 : 0),
										fill: color,
										fillOpacity: isSelected ? 1 : 0.82,
										stroke: isSelected ? "#fff" : "rgba(255,255,255,.35)",
										strokeWidth: isSelected ? 2.2 : 0.8
									}),
									radius[index] > 11 || isSelected
										? h(
											"text",
											{
												x: entry.x,
												y: entry.y + radius[index] + 11,
												textAnchor: "middle",
												fontSize: 8.5,
												fill: "#c3c9da",
												style: { pointerEvents: "none" }
											},
											node.key + " · " + (node.year || "—")
										)
										: null
								);
							})
						)
					),
					h(
						"div",
						{ style: { position: "absolute", left: 12, top: 10, display: "flex", gap: 6, alignItems: "center", fontSize: 11.5, color: "#9aa0ae" } },
						h("span", { className: "lg-badge" }, graph.metrics.nodes + " 节点"),
						h("span", { className: "lg-badge" }, graph.metrics.edges + " 边"),
						h("span", { className: "lg-badge" }, graph.metrics.clusters + " 簇"),
						h(
							"span",
							{ style: { display: "inline-flex", alignItems: "center", gap: 2 } },
							h("button", { className: "lg-btn", style: { padding: "2px 7px" }, title: "缩小", onClick: function () { zoomBy(1 / 1.25); } }, "−"),
							h("span", { style: { minWidth: 38, textAlign: "center", fontSize: 11, color: "#9aa0ae" } }, Math.round(transform.k * 100) + "%"),
							h("button", { className: "lg-btn", style: { padding: "2px 7px" }, title: "放大", onClick: function () { zoomBy(1.25); } }, "+")
						),
						h("button", { className: "lg-btn", style: { padding: "3px 8px" }, onClick: function () { setTransform({ x: 0, y: 0, k: 1 }); } }, "重置视图")
					),
					h(
						"div",
						{ style: { position: "absolute", left: 12, right: 12, bottom: 8, display: "flex", alignItems: "flex-end", gap: 2, height: 42, opacity: 0.85 } },
						timeline.map(function (entry) {
							var height = 6 + (entry.count / maxYearCount) * 30;
							return h("div", {
								key: entry.year,
								title: entry.year + "：" + entry.count + " 篇",
								style: { flex: 1, height: height, background: "rgba(99,102,241,.55)", borderRadius: "3px 3px 0 0" }
							});
						})
					)
				),
				h(
					"div",
					{ className: "lg-scroll", style: { width: 330, borderLeft: "1px solid rgba(255,255,255,.08)", padding: "14px 16px" } },
					selectedNode
						? h(
							"div",
							null,
							h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 6 } }, h("span", { className: "lg-badge", style: { background: "rgba(99,102,241,.22)", color: "#c7cbff" } }, selectedNode.node.key), h("span", { style: { fontSize: 11.5, color: "#9aa0ae" } }, "综合分 " + (selectedNode.node.score || 0).toFixed(2))),
							h("div", { style: { fontWeight: 600, lineHeight: 1.45, marginBottom: 8 } }, selectedNode.node.label),
							h("div", { style: { fontSize: 11.5, color: "#9aa0ae", display: "grid", gap: 3 } },
								h("div", null, "年份：" + (selectedNode.node.year || "—")),
								h("div", null, "载体：" + (selectedNode.node.venue || "未注明")),
								h("div", null, "被引：" + fmt(selectedNode.node.citedBy)),
								h("div", null, "作者：" + ((selectedNode.node.authors || []).join(", ") || "—")),
								h("div", null, "数据源：" + ((selectedNode.node.sources || []).join(", ")))
							),
							h(ScoreBars, { scores: selectedNode.node.scores }),
							selectedNode.node.url
								? h("a", { href: selectedNode.node.url, target: "_blank", rel: "noreferrer", style: { display: "inline-block", marginTop: 10, color: "#8b9dff", fontSize: 12 } }, "打开原文 ↗")
								: null
						)
						: h("div", { style: { color: "#8b91a1", fontSize: 12.5 } }, "点击节点查看文献详情"),
					h(
						"div",
						{ style: { marginTop: 20 } },
						h("div", { style: { fontSize: 11.5, color: "#8b91a1", marginBottom: 8, textTransform: "uppercase", letterSpacing: ".08em" } }, "主题簇"),
						(graph.clusters || []).map(function (cluster) {
							return h(
								"div",
								{ key: cluster.id, style: { display: "flex", gap: 8, alignItems: "center", padding: "4px 0", fontSize: 12 } },
								h("span", { style: { width: 9, height: 9, borderRadius: 9, background: CLUSTER_COLORS[cluster.id % CLUSTER_COLORS.length], flex: "0 0 auto" } }),
								h("span", { style: { flex: 1, color: "#c3c9da" } }, cluster.label),
								h("span", { style: { color: "#8b91a1" } }, cluster.size)
							);
						})
					)
				)
			);
		}

		/* ------------------------------------------------------------- markdown */

		function inline(text, keyPrefix) {
			var parts = [];
			var pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\s]{1,40}\]\([^)]+\)|\*[^*]+\*|\[P\d+\])/g;
			var lastIndex = 0;
			var match;
			var index = 0;
			while ((match = pattern.exec(text)) !== null) {
				if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
				var token = match[0];
				index += 1;
				if (token.startsWith("**")) {
					parts.push(h("strong", { key: keyPrefix + index }, token.slice(2, -2)));
				} else if (token.startsWith("`")) {
					parts.push(h("code", { key: keyPrefix + index }, token.slice(1, -1)));
				} else if (token.startsWith("[P")) {
					parts.push(h("span", { key: keyPrefix + index, className: "lg-badge", style: { background: "rgba(99,102,241,.22)", color: "#c7cbff" } }, token.slice(1, -1)));
				} else if (token.indexOf("](") > 0) {
					var split = token.slice(1, -1).split("](");
					parts.push(h("a", { key: keyPrefix + index, href: split[1], target: "_blank", rel: "noreferrer" }, split[0]));
				} else {
					parts.push(h("em", { key: keyPrefix + index }, token.slice(1, -1)));
				}
				lastIndex = match.index + token.length;
			}
			if (lastIndex < text.length) parts.push(text.slice(lastIndex));
			return parts;
		}

		function Markdown(props) {
			var blocks = useMemo(function () {
				var lines = String(props.source || "").replace(/\r\n/g, "\n").split("\n");
				var out = [];
				var i = 0;
				while (i < lines.length) {
					var line = lines[i];
					if (/^```/.test(line)) {
						var code = [];
						i += 1;
						while (i < lines.length && !/^```/.test(lines[i])) {
							code.push(lines[i]);
							i += 1;
						}
						i += 1;
						out.push(h("pre", { key: "pre" + out.length }, h("code", null, code.join("\n"))));
						continue;
					}
					if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
						var header = splitRow(line);
						var rows = [];
						i += 2;
						while (i < lines.length && /^\s*\|/.test(lines[i])) {
							rows.push(splitRow(lines[i]));
							i += 1;
						}
						out.push(
							h(
								"table",
								{ key: "table" + out.length },
								h("thead", null, h("tr", null, header.map(function (cell, index) { return h("th", { key: index }, inline(cell, "th" + index)); }))),
								h("tbody", null, rows.map(function (row, rowIndex) {
									return h("tr", { key: rowIndex }, row.map(function (cell, cellIndex) {
										return h("td", { key: cellIndex }, inline(cell, "td" + rowIndex + "_" + cellIndex));
									}));
								}))
							)
						);
						continue;
					}
					var heading = line.match(/^(#{1,4})\s+(.*)$/);
					if (heading) {
						var level = heading[1].length;
						out.push(h("h" + level, { key: "h" + out.length }, inline(heading[2], "hh" + out.length)));
						i += 1;
						continue;
					}
					if (/^>\s?/.test(line)) {
						var quoted = [];
						while (i < lines.length && /^>\s?/.test(lines[i])) {
							quoted.push(lines[i].replace(/^>\s?/, ""));
							i += 1;
						}
						out.push(h("blockquote", { key: "q" + out.length }, h("p", null, inline(quoted.join(" "), "q"))));
						continue;
					}
					if (/^\s*[-*]\s+/.test(line)) {
						var items = [];
						while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
							items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
							i += 1;
						}
						out.push(h("ul", { key: "ul" + out.length }, items.map(function (item, index) {
							return h("li", { key: index }, inline(item, "li" + index));
						})));
						continue;
					}
					if (/^\s*\d+\.\s+/.test(line)) {
						var ordered = [];
						while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
							ordered.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
							i += 1;
						}
						out.push(h("ol", { key: "ol" + out.length }, ordered.map(function (item, index) {
							return h("li", { key: index }, inline(item, "oli" + index));
						})));
						continue;
					}
					if (/^\s*---+\s*$/.test(line)) {
						out.push(h("hr", { key: "hr" + out.length }));
						i += 1;
						continue;
					}
					if (line.trim() === "") {
						i += 1;
						continue;
					}
					var paragraph = [];
					while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4}\s|>\s?|```|\s*[-*]\s+|\s*\d+\.\s+|\s*\|)/.test(lines[i])) {
						paragraph.push(lines[i]);
						i += 1;
					}
					out.push(h("p", { key: "p" + out.length }, inline(paragraph.join(" "), "p")));
				}
				return out;
			}, [props.source]);
			function splitRow(line) {
				return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (cell) {
					return cell.trim();
				});
			}
			return h("div", { className: "lg-md" }, blocks);
		}

		/* --------------------------------------------------------- review tab */

		function ReviewPane() {
			var state = useStore();
			var review = state.review;
			useEffect(function () {
				refreshArchives();
			}, []);
			var archives = state.archives || [];
			return h(
				"div",
				{ style: { flex: 1, display: "flex", minHeight: 0 } },
				h(
					"div",
					{ className: "lg-scroll", style: { flex: 1, minWidth: 0 } },
					state.reviewBusy
						? h(
							"div",
							{ style: { padding: 40, color: "#9aa0ae", display: "flex", gap: 10, alignItems: "center" } },
							h("span", { className: "lg-spin" }),
							"正在检索语料并撰写综述…（首次会稍慢）"
						)
						: state.reviewError
							? h("div", { style: { padding: 40, color: "#fca5a5" } }, "生成失败：" + state.reviewError)
							: review
								? h(Markdown, { source: review.markdown })
								: h(
									"div",
									{ style: { padding: 40, color: "#8b91a1", lineHeight: 2 } },
									h("div", { style: { fontSize: 15, color: "#c9cee0", marginBottom: 10 } }, "还没有综述"),
									h("div", null, "输入研究主题后点击「生成综述」。插件会先检索去重，再输出：研究图景 / 方法与证据 / 争议与未解问题 / 研究空白 / 阅读路径。"),
									h("div", { style: { marginTop: 10, opacity: 0.75 } }, "模型可用时由宿主 llm 撰写（可在「设置」里切换 provider / model），不可用时自动回退为确定性启发式综述——同样可用，只是文风更模板化。")
								)
				),
				h(
					"div",
					{ style: { width: 320, borderLeft: "1px solid rgba(255,255,255,.08)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, overflow: "auto" } },
					h("div", { style: { fontSize: 11.5, color: "#8b91a1", textTransform: "uppercase", letterSpacing: ".08em" } }, "综述控制"),
					h("button", { className: "lg-btn primary", disabled: state.reviewBusy, onClick: function () { runReview(true); } }, state.reviewBusy ? "撰写中…" : "用模型重新生成"),
					h("button", { className: "lg-btn", disabled: state.reviewBusy, onClick: function () { runReview(false); } }, "仅启发式（离线）"),
					h("button", { className: "lg-btn", onClick: copyMarkdown }, "复制 Markdown"),
					h("button", { className: "lg-btn", onClick: exportMarkdown }, "导出 .md"),
					h("div", { style: { borderTop: "1px solid rgba(255,255,255,.08)", margin: "4px 0 2px" } }),
					h(
						"div",
						{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 } },
						h("div", { style: { fontSize: 11.5, color: "#8b91a1", textTransform: "uppercase", letterSpacing: ".08em" } }, "工作区"),
						h(
							"button",
							{
								className: "lg-btn",
								style: { padding: "2px 8px", fontSize: 11 },
								title: "重新扫描当前工作区的档案目录",
								disabled: state.archiveBusy,
								onClick: function () { refreshArchives().then(function () { notice("已刷新档案列表"); }); }
							},
							"刷新"
						)
					),
					h(
						"select",
						{
							className: "lg-select",
							title: "切换工作区会重新读取该工作区下的 .literature-review",
							value: state.workspace || "",
							onChange: function (event) { selectWorkspace(event.target.value); }
						},
						(state.workspaceList || []).length === 0
							? h("option", { value: state.workspace || "" }, state.workspace || "（没有已知工作区）")
							: (state.workspaceList || []).map(function (entry) {
								return h("option", { key: entry.path, value: entry.path }, entry.title + " · " + entry.path);
							})
					),
					h("div", { style: { fontSize: 11.5, color: "#8b91a1", textTransform: "uppercase", letterSpacing: ".08em" } }, "文献综述档案"),
					h(
						"select",
						{
							className: "lg-select",
							value: state.archiveId || "",
							onChange: function (event) { setState({ archiveId: event.target.value }); }
						},
						h("option", { value: "" }, archives.length > 0 ? "（未选择）" : "（本工作区还没有档案）"),
						archives.map(function (entry) {
							return h(
								"option",
								{ key: entry.id, value: entry.id },
								entry.title + " · " + (entry.paperCount || 0) + " 篇"
							);
						})
					),
					h("input", {
						className: "lg-input",
						placeholder: "新档案标题（默认用当前主题）",
						value: state.archiveTitle || "",
						onChange: function (event) { setState({ archiveTitle: event.target.value }); }
					}),
					h(
						"div",
						{ style: { display: "flex", gap: 6 } },
						h("button", { className: "lg-btn", style: { flex: 1 }, disabled: state.archiveBusy, onClick: createArchive }, "新建"),
						h("button", { className: "lg-btn", style: { flex: 1 }, disabled: state.archiveBusy, onClick: saveToArchive }, state.archiveBusy ? "写入中…" : "保存"),
						h("button", { className: "lg-btn", style: { flex: 1 }, disabled: state.archiveBusy || !state.archiveId, onClick: function () { openArchive(state.archiveId); } }, "读取")
					),
					h(
						"div",
						{ style: { fontSize: 11, color: "#6b7280", lineHeight: 1.65, wordBreak: "break-all" } },
						state.archiveRoot ? "目录：" + state.archiveRoot : "目录：解析中…"
					),
					state.archiveError ? h("div", { style: { fontSize: 11.5, color: "#fca5a5" } }, state.archiveError) : null,
					review
						? h(
							"div",
							{ style: { marginTop: 6, display: "grid", gap: 6, fontSize: 11.5, color: "#9aa0ae" } },
							h("div", null, "模式：" + (review.mode === "llm" ? "模型撰写" : review.mode === "archive" ? "档案原文" : "启发式合成")),
							review.llm && review.llm.ok ? h("div", null, "模型：" + review.llm.provider + "/" + review.llm.model) : null,
							review.llm && review.llm.ok === false ? h("div", { style: { color: "#fbbf24" } }, "模型回退原因：" + review.llm.error) : null,
							h("div", null, "章节：" + (review.sections || []).length),
							h(
								"div",
								{ style: { marginTop: 4 } },
								(review.sections || []).map(function (section, index) {
									return h("div", { key: index, style: { opacity: 0.8, padding: "2px 0" } }, "· " + section);
								})
							)
						)
						: null,
					h("div", { style: { marginTop: "auto", fontSize: 11, color: "#6b7280", lineHeight: 1.7 } }, "综述是定位与筛选的辅助地图；引用前请回到原文核对。")
				)
			);
		}

		/* -------------------------------------------------------- settings tab */

		function SettingsPane() {
			var state = useStore();
			var config = (state.status && state.status.config) || null;
			var allProviders = (state.status && state.status.providers) || ["openalex", "crossref", "semanticscholar", "arxiv"];
			var enabled = config ? config.providers || [] : state.providers;
			var llm = config && config.llm ? config.llm : { enabled: true, provider: "deepseek-official", model: "deepseek-flash", maxTokens: 3000, temperature: 0.3 };
			var llmProviders = (state.status && state.status.llmProviders) || [];
			var toggle = function (id) {
				var next = enabled.indexOf(id) >= 0 ? enabled.filter(function (x) { return x !== id; }) : enabled.concat([id]);
				saveConfig({ providers: next.length > 0 ? next : [id] });
			};
			return h(
				"div",
				{ className: "lg-scroll", style: { flex: 1, padding: "20px 24px 60px" } },
				h("div", { style: { maxWidth: 720 } },
					h("h3", { style: { margin: "0 0 4px", fontSize: 14 } }, "数据源"),
					h("p", { style: { margin: "0 0 12px", fontSize: 12, color: "#8b91a1" } }, "默认全部启用。Crossref 与 OpenAlex 无需密钥；Semantic Scholar 有匿名限流，失败会自动降级不影响整体。"),
					h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
						allProviders.map(function (id) {
							var on = enabled.indexOf(id) >= 0;
							return h("button", {
								key: id,
								className: "lg-btn",
								style: on ? { borderColor: "rgba(99,102,241,.7)", color: "#c7cbff", background: "rgba(99,102,241,.16)" } : { opacity: 0.55 },
								onClick: function () { toggle(id); }
							}, (on ? "✓ " : "") + id);
						})
					),
					h("h3", { style: { margin: "26px 0 4px", fontSize: 14 } }, "综述模型"),
					h("p", { style: { margin: "0 0 12px", fontSize: 12, color: "#8b91a1" } }, "走宿主内置 llm 服务，无需额外密钥。留空或关闭时会使用确定性启发式综述。"),
					h("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" } },
						h("label", { style: { display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12 } },
							h("input", {
								type: "checkbox",
								checked: llm.enabled !== false,
								onChange: function (event) { saveConfig({ llm: Object.assign({}, llm, { enabled: event.target.checked }) }); }
							}),
							"启用模型撰写"
						),
						h("select", {
							className: "lg-select",
							style: { minWidth: 170 },
							value: llm.provider || "",
							onChange: function (event) { saveConfig({ llm: Object.assign({}, llm, { provider: event.target.value }) }); }
						},
							h("option", { value: "" }, "（不指定 provider）"),
							llmProviders.map(function (entry) {
								return h("option", { key: entry.id, value: entry.id }, entry.name || entry.id);
							}),
							llmProviders.length === 0 ? h("option", { value: "deepseek-official" }, "deepseek-official") : null,
							llmProviders.every(function (entry) { return entry.id !== "deepseek-official"; })
								? h("option", { value: "deepseek-official" }, "deepseek-official")
								: null
						),
						h("input", {
							className: "lg-input",
							style: { width: 190 },
							placeholder: "model，如 deepseek-flash",
							key: "model-" + (llm.model || ""),
							defaultValue: llm.model || "",
							onBlur: function (event) { saveConfig({ llm: Object.assign({}, llm, { model: event.target.value.trim() }) }); }
						}),
						h("label", { style: { display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12 } },
							"maxTokens",
							h("input", {
								className: "lg-input",
								type: "number",
								style: { width: 90 },
								value: llm.maxTokens || 3000,
								onChange: function (event) { saveConfig({ llm: Object.assign({}, llm, { maxTokens: Number(event.target.value) }) }); }
							})
						)
					),
					h("h3", { style: { margin: "26px 0 4px", fontSize: 14 } }, "综述语言与默认范围"),
					h("div", { style: { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", fontSize: 12 } },
						h("select", {
							className: "lg-select",
							value: config ? config.language || "zh" : "zh",
							onChange: function (event) { saveConfig({ language: event.target.value }); }
						},
							h("option", { value: "zh" }, "中文综述"),
							h("option", { value: "en" }, "English review")
						),
						h("label", { style: { display: "inline-flex", gap: 6, alignItems: "center" } },
							"默认年份",
							h("input", { className: "lg-input", style: { width: 72 }, placeholder: "从", value: config && config.yearFrom ? String(config.yearFrom) : "", onChange: function (event) { saveConfig({ yearFrom: event.target.value ? Number(event.target.value) : null }); } }),
							h("input", { className: "lg-input", style: { width: 72 }, placeholder: "至", value: config && config.yearTo ? String(config.yearTo) : "", onChange: function (event) { saveConfig({ yearTo: event.target.value ? Number(event.target.value) : null }); } })
						)
					),
					h("h3", { style: { margin: "26px 0 4px", fontSize: 14 } }, "工作区与档案"),
					h("p", { style: { margin: "0 0 10px", fontSize: 12, color: "#8b91a1", lineHeight: 1.8 } },
						"综述按工作区存放：",
						h("code", null, "<工作区>/.literature-review/"),
						"，每份综述一个 ",
						h("code", null, "001-标题/"),
						" 子目录（meta.json / review.md / papers.json / graph.json），并在 ",
						h("code", null, "index.json"),
						" 里登记。留空时使用宿主已知的第一个工作区。"
					),
					h("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
						h(
							"select",
							{
								className: "lg-select",
								style: { flex: 1, maxWidth: 460 },
								value: state.workspace || "",
								onChange: function (event) {
									selectWorkspace(event.target.value);
									saveConfig({ workspace: event.target.value });
								}
							},
							(state.workspaceList || []).length === 0
								? h("option", { value: state.workspace || "" }, state.workspace || "（没有已知工作区）")
								: (state.workspaceList || []).map(function (entry) {
									return h("option", { key: entry.path, value: entry.path }, entry.title + " · " + entry.path);
								})
						),
						h(
							"button",
							{ className: "lg-btn", onClick: function () { refreshArchives(); } },
							"刷新"
						),
						h("span", { className: "lg-badge", title: state.archiveRoot || "" }, state.archiveRoot ? "档案目录已解析" : "档案目录未解析")
					),
					h("p", { style: { margin: "8px 0 0", fontSize: 11.5, color: "#6b7280", lineHeight: 1.7 } },
						"列表来自宿主工作区注册表；选中的工作区会成为默认落盘位置。想手动指定路径时，在上面的列表没有目标工作区的情况下，先在宿主里把该目录加为工作区。"
					),
					state.archiveRoot
						? h("div", { style: { marginTop: 8, fontSize: 11.5, color: "#6b7280", wordBreak: "break-all" } }, state.archiveRoot)
						: null,
					h("h3", { style: { margin: "26px 0 4px", fontSize: 14 } }, "接口与礼貌池"),
					h("p", { style: { margin: "0 0 10px", fontSize: 12, color: "#8b91a1" } }, "填写邮箱可加入 OpenAlex / Crossref 的 polite pool，获得更稳定的配额（可选）。"),
					h("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
						h("input", {
							className: "lg-input",
							style: { flex: 1, maxWidth: 320 },
							placeholder: "you@example.com",
							defaultValue: config ? config.mailto || "" : "",
							onBlur: function (event) { saveConfig({ mailto: event.target.value.trim() }); }
						}),
						h("span", { className: "lg-badge" }, "已就绪: " + (state.status && state.status.version ? "v" + state.status.version : "—"))
					),
					h("h3", { style: { margin: "26px 0 4px", fontSize: 14 } }, "Agent 工具"),
					h("div", { style: { fontSize: 12, color: "#9aa0ae", lineHeight: 1.9 } },
						h("div", null, h("code", null, "litgraph_search"), " — 跨源检索 + 六维评分排序"),
						h("div", null, h("code", null, "litgraph_map"), " — 知识图谱：节点/边/主题簇/年度分布"),
						h("div", null, h("code", null, "litgraph_review"), " — 结构化文献综述（Markdown）"),
						h("div", null, h("code", null, "litgraph_archives"), " — 列出当前工作区的综述档案"),
						h("div", null, h("code", null, "litgraph_archive_create"), " — 新建一份空白档案"),
						h("div", null, h("code", null, "litgraph_archive_save"), " — 检索 + 撰写 + 写入 .literature-review/"),
						h("div", null, h("code", null, "litgraph_archive_read"), " — 读取已保存档案的综述正文")
					)
				)
			);
		}

		/* ------------------------------------------------------------- overlay */

		/* A render error inside the panel must not collapse the overlay into a
		 * blank layer: show the message so the failure is diagnosable. */
		class ErrorBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error: error };
			}
			render() {
				if (!this.state.error) return this.props.children;
				var detail = String(
					(this.state.error && this.state.error.stack) || this.state.error || "unknown error"
				);
				return h(
					"div",
					{ className: "lg-root" },
					h("div", {
						className: "lg-backdrop",
						onClick: function () {
							setState({ open: false });
						}
					}),
					h(
						"div",
						{ className: "lg-panel", style: { padding: 24, overflow: "auto" } },
						h("div", { style: { fontSize: 15, color: "#fca5a5", marginBottom: 12 } }, "面板渲染出错"),
						h(
							"pre",
							{ style: { fontSize: 12, lineHeight: 1.6, color: "#c9cee0", whiteSpace: "pre-wrap", wordBreak: "break-word" } },
							detail
						),
						h(
							"button",
							{
								className: "lg-btn",
								style: { marginTop: 16 },
								onClick: function () {
									setState({ open: false });
								}
							},
							"关闭面板"
						)
					)
				);
			}
		}

		function Panel(props) {
			var state = useStore();
			if (!state.open) return null;
			return h(ErrorBoundary, null, h(PanelContent, props));
		}

		function PanelContent() {
			var state = useStore();
			/* Workspace list comes from the host registry over HTTP: no reliance on
			 * slot props, so a slot-contract change cannot break the panel. */
			useEffect(function () {
				refreshArchives();
				var onKey = function (event) {
					if (event.key === "Escape") setState({ open: false });
				};
				window.addEventListener("keydown", onKey);
				return function () {
					window.removeEventListener("keydown", onKey);
				};
			}, []);
			var tabs = [
				["search", "检索"],
				["graph", "图谱"],
				["review", "综述"],
				["settings", "设置"]
			];
			return h(
				"div",
				{ className: "lg-root" },
				h("div", {
					className: "lg-backdrop",
					onClick: function () {
						setState({ open: false });
					}
				}),
				h(
					"div",
					{ className: "lg-panel" },
					h(
						"div",
						{ className: "lg-head" },
						h(
							"svg",
							{ width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "#a5b4fc", strokeWidth: 1.8, strokeLinecap: "round" },
							h("circle", { cx: 11, cy: 11, r: 7 }),
							h("path", { d: "M20 20l-3.5-3.5" }),
							h("path", { d: "M11 8v6M8 11h6" })
						),
						h("div", { style: { fontWeight: 600, fontSize: 14 } }, "AI 文献发现 · LitGraph"),
						state.query ? h("span", { style: { color: "#8b91a1", fontSize: 12 } }, "— " + state.query) : null,
						h("div", { style: { marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" } },
							state.notice
								? h("span", { style: { fontSize: 11.5, color: state.notice.kind === "err" ? "#fca5a5" : state.notice.kind === "warn" ? "#fbbf24" : "#6ee7b7" } }, state.notice.text)
								: null,
							h("button", {
								className: "lg-btn",
								style: { padding: "3px 9px" },
								title: "关闭 (Esc)",
								onClick: function () {
									setState({ open: false });
								}
							}, "✕")
						)
					),
					h(
						"div",
						{ className: "lg-tabs" },
						tabs.map(function (entry) {
							return h(
								"button",
								{
									key: entry[0],
									className: cls("lg-tab", state.tab === entry[0] && "on"),
									onClick: function () {
										setState({ tab: entry[0] });
									}
								},
								entry[1]
							);
						}),
						h("span", { style: { marginLeft: "auto", fontSize: 11.5, color: "#6b7280" } },
							state.result && state.result.papers ? state.result.papers.length + " 篇语料" : "未检索")
					),
					h(
						"div",
						{ className: "lg-body" },
						state.tab === "search" ? h(SearchPane) : null,
						state.tab === "graph" ? h(GraphPane) : null,
						state.tab === "review" ? h(ReviewPane) : null,
						state.tab === "settings" ? h(SettingsPane) : null
					)
				)
			);
		}

		/* ---------------------------------------------------------------- apply */

		var inject = ["slots"];

		/* 样式挂在 document.head 上一次，面板关闭时侧边栏按钮也要有样式。 */
		function ensureStyles() {
			if (typeof document === "undefined" || !document.head) return;
			var existing = document.getElementById("dsh-litgraph-style");
			if (existing) {
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return;
			}
			var style = document.createElement("style");
			style.id = "dsh-litgraph-style";
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({ name: "shell.overlay", id: "litgraph", order: 45, label: "LitGraph" }, function (props) {
					return h(Panel, props || {});
				});
			});
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register({ name: "sidebar.footer.action", id: "litgraph", order: 40 }, function () {
					return h(Launcher);
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
