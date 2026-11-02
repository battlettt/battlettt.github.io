/* Model Scout v1: client-side ranking engine and UI.
   The engine functions are pure and exported for node tests (tests/run_tests.js).
   The UI code only runs in a browser. No model APIs are called; the only network
   requests are catalog.json (same folder) and the public OpenRouter model list. */
(function (root) {
  "use strict";

  var STALE_AFTER_DAYS = 90;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
  var REQUIRED_FIELDS = [
    "id", "model", "provider", "kind", "context_window", "input_price_per_mtok",
    "output_price_per_mtok", "price_status", "latency_class", "strengths", "limits",
    "source", "last_verified"
  ];
  var PRICE_STATUSES = ["verified", "unverified", "self-hosted", "live"];
  var TASK_LABELS = {
    chat: "chat and writing", code: "coding", rag: "RAG (answering from your documents)",
    vision: "vision (images)", embeddings: "embeddings (search vectors)", agentic: "agentic work (tools, multi-step)"
  };
  var COMPONENT_LABELS = { cost: "cost", quality: "quality", latency: "speed", context: "context fit", privacy: "privacy" };
  var LATENCY_SCORE = { fast: 1, medium: 0.6, slow: 0.25 };
  var QUALITY_BAR_MIN = { basic: 1, good: 3, frontier: 5 };
  var HARDWARE_SCORE = { laptop: 1, workstation: 0.8, server: 0.5, cluster: 0.2, unknown: 0.4 };
  var HARDWARE_LABEL = {
    laptop: "a laptop", workstation: "a workstation with one strong GPU", server: "a multi-GPU server",
    cluster: "a GPU cluster", unknown: "unknown hardware (size not listed)"
  };
  var COST_LOG_LO = 0.05; // $/M blended price that scores 1.0
  var COST_LOG_HI = 30;   // $/M blended price that scores 0.0
  var SWITCH_MARGIN = 5;  // points a challenger must win by before switching is worth it

  // ---------- small helpers ----------
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function round(x, d) { var p = Math.pow(10, d || 0); return Math.round(x * p) / p; }

  // ---------- cost math ----------
  /** Monthly cost in USD. Prices are per million tokens. Returns null if a price is unknown. */
  function monthlyCost(model, inputTokens, outputTokens) {
    var pin = model.input_price_per_mtok, pout = model.output_price_per_mtok;
    if (!isNum(pin) || !isNum(pout)) return null;
    return (inputTokens / 1e6) * pin + (outputTokens / 1e6) * pout;
  }

  /** Blended $/M for the user's input/output mix. Defaults to a 3:1 input:output mix. */
  function blendedPrice(model, inputTokens, outputTokens) {
    var pin = model.input_price_per_mtok, pout = model.output_price_per_mtok;
    if (!isNum(pin) || !isNum(pout)) return null;
    var i = inputTokens > 0 ? inputTokens : 0, o = outputTokens > 0 ? outputTokens : 0;
    if (i + o === 0) { i = 3; o = 1; }
    return (i * pin + o * pout) / (i + o);
  }

  // ---------- staleness ----------
  function parseDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
    var t = Date.parse(s.length === 10 ? s + "T00:00:00Z" : s);
    return isNaN(t) ? null : t;
  }

  /** Stale = verification date missing, unparseable, in the future, or older than maxDays. */
  function staleStatus(entry, now, maxDays) {
    var limit = isNum(maxDays) ? maxDays : STALE_AFTER_DAYS;
    var nowMs = now instanceof Date ? now.getTime() : (isNum(now) ? now : Date.now());
    var t = parseDate(entry && entry.last_verified);
    if (t === null) return { stale: true, ageDays: null, reason: "No verification date: treat these specs as unverified." };
    var age = Math.floor((nowMs - t) / DAY_MS);
    if (age < -1) return { stale: true, ageDays: age, reason: "Verification date is in the future, which is not possible: treat as unverified." };
    if (age > limit) return { stale: true, ageDays: age, reason: "Last verified " + age + " days ago (more than " + limit + "): prices or limits may have changed." };
    return { stale: false, ageDays: Math.max(age, 0), reason: "Verified " + Math.max(age, 0) + " days ago." };
  }

  // ---------- catalog validation ----------
  /** Returns a list of problems. An empty list means the entry is usable. */
  function validateEntry(e) {
    var errs = [];
    if (!e || typeof e !== "object") return ["entry is not an object"];
    REQUIRED_FIELDS.forEach(function (f) { if (!(f in e)) errs.push("missing field: " + f); });
    if (PRICE_STATUSES.indexOf(e.price_status) < 0) errs.push("price_status must be one of " + PRICE_STATUSES.join(", "));
    ["input_price_per_mtok", "output_price_per_mtok"].forEach(function (f) {
      var v = e[f];
      if (v === null) { if (e.price_status !== "unverified") errs.push(f + " is null but price_status is not unverified"); }
      else if (!isNum(v) || v < 0) errs.push(f + " must be a non-negative number or null with price_status unverified");
    });
    if (e.context_window !== null && (!isNum(e.context_window) || e.context_window <= 0)) errs.push("context_window must be a positive number or null");
    if (["fast", "medium", "slow", null].indexOf(e.latency_class) < 0) errs.push("latency_class must be fast, medium, slow, or null");
    if (e.quality_tier != null && (!isNum(e.quality_tier) || e.quality_tier < 1 || e.quality_tier > 5)) errs.push("quality_tier must be 1 to 5 or null");
    if (!Array.isArray(e.strengths)) errs.push("strengths must be a list");
    if (!Array.isArray(e.limits)) errs.push("limits must be a list");
    var hasSource = e.source && typeof e.source.name === "string" && e.source.name.length > 0;
    if (!hasSource) errs.push("missing source");
    if (parseDate(e.last_verified) === null && e.price_status !== "unverified") {
      errs.push("no valid last_verified date and not flagged unverified");
    }
    return errs;
  }

  /** Every flag the UI should show for an entry's data quality. */
  function dataFlags(e, now) {
    var flags = [];
    var st = staleStatus(e, now);
    if (st.stale) flags.push({ level: "warn", text: "Stale: " + st.reason });
    if (e.price_status === "unverified") flags.push({ level: "warn", text: "Price not verified: the figure shown is not confirmed by a current source." });
    if (e.unverified_fields && e.unverified_fields.length) {
      flags.push({ level: "warn", text: "Not verified: " + e.unverified_fields.join(", ").replace(/_/g, " ") + "." });
    }
    if (e.quality_tier == null) flags.push({ level: "info", text: "Quality not rated: this model came from live data and has no editorial tier." });
    if (e.latency_class == null) flags.push({ level: "info", text: "Speed not rated." });
    return flags;
  }

  // ---------- weights ----------
  /** Weights respond to the user's constraints and always sum to 1. */
  function computeWeights(p) {
    var w = { cost: 1, quality: 1, latency: 0.6, context: 0.6, privacy: 0.15 };
    if (isNum(p.budget) && p.budget > 0) {
      if (p.budget <= 1) w.cost += 1.5;
      else if (p.budget <= 5) w.cost += 0.6;
      else w.cost += 0.2;
    }
    if (p.quality === "frontier") w.quality += 1.5;
    else if (p.quality === "good") w.quality += 0.5;
    else if (p.quality === "basic") { w.quality -= 0.4; w.cost += 0.4; }
    if (p.latency === "fast") w.latency += 1.2;
    else if (p.latency === "balanced") w.latency += 0.3;
    else if (p.latency === "any") w.latency = 0.2;
    var need = p.contextNeed || 0;
    if (need >= 200000) w.context += 1.2;
    else if (need >= 32000) w.context += 0.4;
    if (p.localOnly) w.privacy += 1.5;
    if (p.taskType === "agentic") w.quality += 0.3;
    if (p.taskType === "embeddings") w.cost += 0.3;
    var sum = 0, k;
    for (k in w) sum += w[k];
    for (k in w) w[k] = w[k] / sum;
    return w;
  }

  // ---------- scoring ----------
  function costScoreFromPrice(b) {
    if (b <= 0) return 1;
    var s = 1 - (Math.log10(b) - Math.log10(COST_LOG_LO)) / (Math.log10(COST_LOG_HI) - Math.log10(COST_LOG_LO));
    return clamp(s, 0, 1);
  }

  /** Score one model against a profile. Returns components (0..1), total (0..100), flags, or an exclusion. */
  function scoreModel(m, p, w, now) {
    var r = { model: m, excluded: false, excludeReason: "", components: {}, total: 0, flags: [], notes: [] };
    var task = p.taskType || "chat";
    var isEmbedTask = task === "embeddings";
    if (isEmbedTask && m.kind !== "embedding") return excl(r, "Not an embedding model, and your task is embeddings.");
    if (!isEmbedTask && m.kind === "embedding") return excl(r, "Embedding model: it makes search vectors and cannot generate text.");
    var mods = m.input_modalities || ["text"];
    var needMod = p.modality || "text";
    if (task === "vision" && needMod === "text") needMod = "image";
    if (mods.indexOf(needMod) < 0) return excl(r, "Does not accept " + needMod + " input.");
    if (p.localOnly && !m.open_weights) return excl(r, "Hosted only: no downloadable weights, and your profile is local-only.");

    var c = r.components;
    // cost
    if (p.localOnly) {
      var hw = m.local_hardware || "unknown";
      c.cost = HARDWARE_SCORE[hw] != null ? HARDWARE_SCORE[hw] : HARDWARE_SCORE.unknown;
      r.notes.push("Self-hosted: needs " + (HARDWARE_LABEL[hw] || HARDWARE_LABEL.unknown) + ". Cost score reflects hardware size, not a per-token price.");
    } else {
      var b = blendedPrice(m, p.inputTokens, p.outputTokens);
      if (b === null) { c.cost = 0.5; r.flags.push("Price unknown, so cost was scored as average."); }
      else {
        c.cost = costScoreFromPrice(b);
        if (isNum(p.budget) && p.budget > 0 && b > p.budget) {
          c.cost *= 0.25;
          r.flags.push("Over budget: about $" + round(b, 3) + " per million tokens for your mix, above your $" + p.budget + " limit.");
        }
      }
    }
    // quality
    if (m.quality_tier == null) { c.quality = 0.5; r.flags.push("Quality not rated (live-only model), scored as average."); }
    else {
      c.quality = m.quality_tier / 5;
      var bar = QUALITY_BAR_MIN[p.quality] || 1;
      if (m.quality_tier < bar) { c.quality *= 0.5; r.belowBar = true; r.flags.push("Below your quality bar (" + p.quality + ")."); }
    }
    // latency
    if (m.latency_class == null) c.latency = 0.5;
    else {
      c.latency = LATENCY_SCORE[m.latency_class];
      if (p.latency === "fast" && m.latency_class === "slow") r.flags.push("Likely slower than your speed target.");
    }
    // context
    var need = p.contextNeed || 0;
    if (isEmbedTask) {
      c.context = 1;
      if (isNum(m.context_window) && need > m.context_window) r.notes.push("Embeddings work per chunk: split documents into pieces under " + fmtTokens(m.context_window) + " tokens.");
    }
    else if (!isNum(m.context_window)) { c.context = 0.5; r.flags.push("Context window unknown."); }
    else if (need <= 0 || m.context_window >= need) c.context = 1;
    else {
      c.context = 0.5 * Math.pow(m.context_window / need, 2);
      r.flags.push("Context too short: " + fmtTokens(m.context_window) + " tokens, you need " + fmtTokens(need) + ".");
    }
    // privacy
    c.privacy = m.open_weights ? 1 : 0.3;

    var sum = 0;
    Object.keys(w).forEach(function (k) { sum += w[k] * c[k]; });
    var fit = 1;
    if (Array.isArray(m.task_fit) && m.task_fit.indexOf(task) < 0) {
      fit = 0.7;
      r.flags.push("Not positioned for " + (TASK_LABELS[task] || task) + ".");
    }
    if (r.belowBar) fit *= 0.8;
    r.fit = fit;
    r.total = round(100 * sum * fit, 1);
    return r;
  }

  function excl(r, reason) { r.excluded = true; r.excludeReason = reason; return r; }

  /** Rank all models. Ties are broken by lower monthly cost, then by name. */
  function rankModels(models, p, now) {
    var w = computeWeights(p);
    var all = models.map(function (m) { return scoreModel(m, p, w, now); });
    var ranked = all.filter(function (r) { return !r.excluded; });
    ranked.sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      var ca = monthlyCost(a.model, p.inputTokens, p.outputTokens), cb = monthlyCost(b.model, p.inputTokens, p.outputTokens);
      if (ca !== cb) return (ca === null ? Infinity : ca) - (cb === null ? Infinity : cb);
      return a.model.model.localeCompare(b.model.model);
    });
    ranked.forEach(function (r, i) { r.rank = i + 1; r.explain = explain(r, ranked[0], ranked[1], p, w); });
    return { weights: w, ranked: ranked, excluded: all.filter(function (r) { return r.excluded; }) };
  }

  // ---------- plain-language reasons ----------
  var GOOD_WORDS = {
    cost: "low cost for your volume", quality: "a high quality tier", latency: "fast responses",
    context: "enough context for your inputs", privacy: "open weights you can run yourself"
  };
  var BAD_WORDS = {
    cost: "a higher price", quality: "a lower quality tier", latency: "slower responses",
    context: "a context window shorter than your longest input", privacy: "sending data to a hosted provider"
  };

  function explain(r, top, second, p, w) {
    var c = r.components, keys = Object.keys(w);
    var contrib = keys.map(function (k) { return { k: k, v: w[k] * c[k], s: c[k] }; });
    contrib.sort(function (a, b) { return b.v - a.v; });
    var goods = contrib.filter(function (x) { return x.s >= 0.6; }).slice(0, 2).map(function (x) { return GOOD_WORDS[x.k]; });
    var why = goods.length ? "Scores well on " + goods.join(" and ") + ", which your profile weights heavily." :
      "No single strength stands out, but it is the best of what remains under your constraints.";
    if (r.model.strengths && r.model.strengths[0]) why += " " + r.model.strengths[0] + ".";

    var bads = keys.filter(function (k) { return c[k] < 0.5; }).sort(function (a, b) { return w[b] - w[a]; }).map(function (k) { return BAD_WORDS[k]; });
    var trade = [];
    if (bads.length) trade.push("You accept " + bads.slice(0, 2).join(" and ") + ".");
    var other = r === top ? second : top;
    if (other) {
      var mc = monthlyCost(r.model, p.inputTokens, p.outputTokens), oc = monthlyCost(other.model, p.inputTokens, p.outputTokens);
      var name = other.model.model;
      if (!p.localOnly && mc !== null && oc !== null && (p.inputTokens + p.outputTokens) > 0 && Math.abs(mc - oc) >= 0.01) {
        trade.push(mc > oc ? "Costs " + fmtMoney(mc - oc) + " more per month than " + name + "." :
          "Saves " + fmtMoney(oc - mc) + " per month versus " + name + ".");
      }
      var qa = r.model.quality_tier, qb = other.model.quality_tier;
      if (qa != null && qb != null && qa < qb) trade.push("Rated a lower quality tier than " + name + " (" + qa + " vs " + qb + " of 5).");
      if (r === top) {
        var lead = round(r.total - other.total, 1);
        trade.push(lead > 0 ? "Leads " + name + " by " + lead + " points." : "Ties with " + name + " on score and ranks first on lower monthly cost or name, so treat the two as equal.");
      }
    }
    if (r.model.limits && r.model.limits[0]) trade.push("Known limit: " + r.model.limits[0] + ".");
    return { why: why, tradeoffs: trade.join(" ") };
  }

  // ---------- switch check ----------
  /** Does any candidate beat the user's current model under their weights? */
  function switchCheck(models, currentId, p, now) {
    var res = rankModels(models, p, now);
    var cur = null;
    res.ranked.forEach(function (r) { if (r.model.id === currentId) cur = r; });
    var exc = null;
    res.excluded.forEach(function (r) { if (r.model.id === currentId) exc = r; });
    if (!cur) return { found: !!exc, excluded: !!exc, excludeReason: exc ? exc.excludeReason : "", better: [], current: null };
    var better = res.ranked.filter(function (r) { return r.total > cur.total; }).map(function (r) {
      return { model: r.model, total: r.total, margin: round(r.total - cur.total, 1) };
    });
    return {
      found: true, excluded: false, current: cur, better: better,
      worthSwitching: better.length > 0 && better[0].margin >= SWITCH_MARGIN,
      stale: staleStatus(cur.model, now)
    };
  }

  // ---------- live data (OpenRouter) ----------
  function perMillion(x) { var v = parseFloat(x); return isFinite(v) ? round(v * 1e6, 4) : null; }

  /** Merge OpenRouter data into the catalog. Returns { models, matched, changed, liveOnly }. */
  function mergeLive(catalogModels, orData, fetchedAt) {
    var byId = {};
    (orData || []).forEach(function (m) { if (m && m.id) byId[m.id] = m; });
    var stamp = fetchedAt.toISOString();
    var matched = 0, changed = [];
    var merged = catalogModels.map(function (e) {
      var live = e.openrouter_id && byId[e.openrouter_id];
      if (!live || !live.pricing) return e;
      var pin = perMillion(live.pricing.prompt), pout = perMillion(live.pricing.completion);
      if (pin === null || pout === null || pin < 0 || pout < 0) return e;
      matched++;
      var copy = JSON.parse(JSON.stringify(e));
      var diffs = [];
      if (pin !== e.input_price_per_mtok) diffs.push("input price $" + e.input_price_per_mtok + " to $" + pin);
      if (pout !== e.output_price_per_mtok) diffs.push("output price $" + e.output_price_per_mtok + " to $" + pout);
      if (isNum(live.context_length) && live.context_length !== e.context_window) diffs.push("context " + fmtTokens(e.context_window) + " to " + fmtTokens(live.context_length));
      copy.input_price_per_mtok = pin;
      copy.output_price_per_mtok = pout;
      if (isNum(live.context_length)) copy.context_window = live.context_length;
      copy.price_status = "live";
      copy.last_verified = stamp;
      copy.live = { fetchedAt: stamp, changes: diffs };
      if (diffs.length) changed.push({ model: e.model, changes: diffs });
      return copy;
    });
    var known = {};
    catalogModels.forEach(function (e) { if (e.openrouter_id) known[e.openrouter_id] = true; });
    var liveOnly = [];
    Object.keys(byId).forEach(function (id) {
      var m = byId[id];
      if (known[id] || /:(free|batch|extended|beta)$/.test(id) || id.indexOf("openrouter/") === 0) return;
      var arch = m.architecture || {};
      var outs = arch.output_modalities || ["text"];
      if (outs.length !== 1 || outs[0] !== "text") return;
      var pin = perMillion(m.pricing && m.pricing.prompt), pout = perMillion(m.pricing && m.pricing.completion);
      if (pin === null || pout === null || pin < 0 || pout < 0) return;
      var provider = id.split("/")[0];
      liveOnly.push({
        id: "live:" + id, model: String(m.name || id).split(": ").pop(), provider: provider, kind: "generation",
        openrouter_id: id, context_window: isNum(m.context_length) ? m.context_length : null,
        input_price_per_mtok: pin, output_price_per_mtok: pout, price_status: "live", unverified_fields: [],
        latency_class: null, quality_tier: null, task_fit: null,
        input_modalities: (arch.input_modalities || ["text"]).filter(function (x) { return ["text", "image", "file", "audio", "video"].indexOf(x) >= 0; }),
        open_weights: !!m.hugging_face_id, local_hardware: m.hugging_face_id ? "unknown" : null,
        strengths: ["Listed live on OpenRouter"], limits: ["Not reviewed by Model Scout: quality and speed are not rated"],
        source: { name: "OpenRouter live model list, fetched " + stamp, url: "https://openrouter.ai/" + id },
        last_verified: stamp, live: { fetchedAt: stamp, changes: [] }, liveOnly: true
      });
    });
    return { models: merged, matched: matched, changed: changed, liveOnly: liveOnly };
  }

  // ---------- task description hints ----------
  /** Simple keyword matching on the plain-language description. Returns suggested settings and why. */
  function suggestFromText(text) {
    var t = String(text || "").toLowerCase(), s = {}, why = [];
    function has(re) { return re.test(t); }
    if (has(/\b(embed|embedding|vector|semantic search|similarity)\b/)) { s.taskType = "embeddings"; why.push("mentions embeddings or vectors"); }
    else if (has(/\b(agent|agentic|tool use|tools|multi-step|autonomous|browse)\b/)) { s.taskType = "agentic"; why.push("mentions agents or tools"); }
    else if (has(/\b(code|coding|program|refactor|bug|repo|pull request|typescript|python)\b/)) { s.taskType = "code"; why.push("mentions code"); }
    else if (has(/\b(image|photo|screenshot|picture|diagram|ocr|scan)\b/)) { s.taskType = "vision"; s.modality = "image"; why.push("mentions images"); }
    else if (has(/\b(rag|retriev|knowledge base|docs|documents|pdf|manual)\b/)) { s.taskType = "rag"; why.push("mentions documents or retrieval"); }
    else if (has(/\b(chat|support|assistant|write|writing|summar|classif|email)\b/)) { s.taskType = "chat"; why.push("mentions chat, writing, or classification"); }
    if (has(/\b(audio|voice|speech|podcast|call recording)\b/)) { s.modality = "audio"; why.push("mentions audio"); }
    if (has(/\b(video)\b/)) { s.modality = "video"; why.push("mentions video"); }
    if (has(/\b(private|confidential|on-prem|on prem|offline|local|hipaa|gdpr|air-gapped|air gapped)\b/)) { s.localOnly = true; why.push("mentions privacy or local use"); }
    if (has(/\b(cheap|budget|low cost|inexpensive|millions of|high volume|classifier)\b/)) { s.budget = 1; why.push("mentions cost or high volume"); }
    if (has(/\b(real-time|realtime|fast|instant|latency|live chat)\b/)) { s.latency = "fast"; why.push("mentions speed"); }
    if (has(/\b(hardest|frontier|best possible|research|complex reasoning|math proof|critical)\b/)) { s.quality = "frontier"; why.push("mentions top quality"); }
    if (has(/\b(long document|long documents|entire codebase|whole codebase|books?|contracts|transcripts|hundreds of pages)\b/)) { s.contextNeed = 400000; why.push("mentions long inputs"); }
    return { settings: s, why: why };
  }

  // ---------- formatting ----------
  function fmtMoney(v) {
    if (v === null || !isNum(v)) return "unknown";
    if (v === 0) return "$0";
    if (v < 0.01) return "under $0.01";
    if (v < 100) return "$" + v.toFixed(2);
    return "$" + Math.round(v).toLocaleString("en-US");
  }
  function fmtPrice(v) { return isNum(v) ? "$" + (v < 0.1 ? String(round(v, 4)) : v.toFixed(2)) : "unknown"; }
  function fmtTokens(n) {
    if (!isNum(n)) return "unknown";
    if (n >= 1e6) return round(n / 1e6, 2) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(n);
  }

  var api = {
    STALE_AFTER_DAYS: STALE_AFTER_DAYS, REQUIRED_FIELDS: REQUIRED_FIELDS, SWITCH_MARGIN: SWITCH_MARGIN,
    monthlyCost: monthlyCost, blendedPrice: blendedPrice, staleStatus: staleStatus, validateEntry: validateEntry,
    dataFlags: dataFlags, computeWeights: computeWeights, scoreModel: scoreModel, rankModels: rankModels,
    switchCheck: switchCheck, mergeLive: mergeLive, suggestFromText: suggestFromText, costScoreFromPrice: costScoreFromPrice,
    fmtMoney: fmtMoney, fmtTokens: fmtTokens
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // =====================================================================
  // Browser UI
  // =====================================================================
  var state = { catalog: null, catalogOrigin: "", base: [], liveOnly: [], live: null, now: new Date() };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function safeUrl(u) { return /^https:\/\//.test(String(u || "")) ? u : "#"; }

  function readProfile() {
    var budgetRaw = $("budget").value.trim();
    var budget = budgetRaw === "" ? null : parseFloat(budgetRaw);
    function tokens(id) { var v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v * 1e6 : 0; }
    return {
      description: $("task-desc").value,
      taskType: $("task-type").value,
      budget: isFinite(budget) && budget > 0 ? budget : null,
      latency: $("latency").value,
      quality: $("quality").value,
      localOnly: $("local-only").checked,
      contextNeed: parseInt($("context-need").value, 10) || 0,
      modality: $("modality").value,
      inputTokens: tokens("vol-in"),
      outputTokens: tokens("vol-out")
    };
  }

  function candidates() {
    return $("include-live").checked ? state.base.concat(state.liveOnly) : state.base;
  }

  function pct(x) { return Math.round(x * 100); }

  function bar(v) {
    return '<span class="bar" aria-hidden="true"><span style="width:' + pct(v) + '%"></span></span>';
  }

  function dataBadge(m) {
    var st = staleStatus(m, state.now);
    if (m.liveOnly) return '<span class="badge live">Live only</span>';
    if (m.price_status === "live") return '<span class="badge live">Live price</span>';
    if (st.stale) return '<span class="badge stale">Stale</span>';
    if (m.price_status === "unverified" || (m.unverified_fields && m.unverified_fields.length)) return '<span class="badge warn">Partly unverified</span>';
    if (m.price_status === "self-hosted") return '<span class="badge ok">Self-hosted</span>';
    return '<span class="badge ok">Verified ' + esc(String(m.last_verified).slice(0, 10)) + "</span>";
  }

  function renderWeights(w) {
    var html = Object.keys(w).map(function (k) {
      return '<li><span class="wname">' + COMPONENT_LABELS[k] + '</span>' + bar(w[k] / 0.5 > 1 ? 1 : w[k] / 0.5) +
        '<span class="wval">' + pct(w[k]) + "%</span></li>";
    }).join("");
    $("weights").innerHTML = html;
  }

  function costCell(r, p) {
    var mc = monthlyCost(r.model, p.inputTokens, p.outputTokens);
    if (p.localOnly) return "Self-hosted<br><small>hosted reference " + esc(fmtMoney(mc)) + "</small>";
    return esc(fmtMoney(mc));
  }

  function render() {
    if (!state.base.length) return;
    var p = readProfile();
    var res = rankModels(candidates(), p, state.now);
    renderWeights(res.weights);
    var top = res.ranked[0];

    // headline
    var head = $("top-pick");
    if (!top) {
      head.innerHTML = '<h3>No model fits every hard constraint</h3><p>Every candidate was excluded. See the excluded list below and loosen a constraint (for example turn off local-only or change the modality).</p>';
    } else {
      var tf = dataFlags(top.model, state.now);
      head.innerHTML =
        '<p class="eyebrow">Top pick for this profile</p>' +
        "<h3>" + esc(top.model.model) + ' <span class="provider">' + esc(top.model.provider) + "</span></h3>" +
        '<p class="score-big">' + top.total + ' <small>of 100</small></p>' +
        '<p><strong>Why:</strong> ' + esc(top.explain.why) + "</p>" +
        '<p><strong>What you trade away:</strong> ' + esc(top.explain.tradeoffs) + "</p>" +
        '<p><strong>Estimated monthly cost:</strong> ' + costCell(top, p) + "</p>" +
        (tf.length ? '<ul class="flags">' + tf.map(function (f) { return '<li class="' + f.level + '">' + esc(f.text) + "</li>"; }).join("") + "</ul>" : "") +
        (top.flags.length ? '<ul class="flags">' + top.flags.map(function (f) { return '<li class="warn">' + esc(f) + "</li>"; }).join("") + "</ul>" : "");
    }

    // table
    var rows = res.ranked.map(function (r) {
      var c = r.components, m = r.model;
      return '<tr class="' + (r.rank === 1 ? "is-top" : "") + '">' +
        "<td>" + r.rank + "</td>" +
        '<th scope="row"><a href="#card-' + esc(m.id) + '">' + esc(m.model) + "</a><br><small>" + esc(m.provider) + "</small></th>" +
        '<td class="num"><strong>' + r.total + "</strong></td>" +
        ["cost", "quality", "latency", "context", "privacy"].map(function (k) { return '<td class="num">' + pct(c[k]) + "</td>"; }).join("") +
        '<td class="num">' + costCell(r, p) + "</td>" +
        '<td class="num">' + fmtPrice(m.input_price_per_mtok) + " / " + fmtPrice(m.output_price_per_mtok) + "</td>" +
        '<td class="num">' + esc(fmtTokens(m.context_window)) + (m.unverified_fields && m.unverified_fields.indexOf("context_window") >= 0 ? "*" : "") + "</td>" +
        "<td>" + dataBadge(m) + "</td></tr>";
    }).join("");
    $("compare-body").innerHTML = rows || '<tr><td colspan="12">No candidates.</td></tr>';
    $("result-count").textContent = res.ranked.length + " ranked, " + res.excluded.length + " excluded by hard constraints.";

    // cards
    $("cards").innerHTML = res.ranked.map(function (r) {
      var m = r.model, c = r.components;
      var flags = dataFlags(m, state.now).map(function (f) { return '<li class="' + f.level + '">' + esc(f.text) + "</li>"; })
        .concat(r.flags.map(function (f) { return '<li class="warn">' + esc(f) + "</li>"; }))
        .concat(r.notes.map(function (f) { return '<li class="info">' + esc(f) + "</li>"; }));
      if (m.live && m.live.changes.length) flags.push('<li class="info">Live data changed: ' + esc(m.live.changes.join("; ")) + ".</li>");
      return '<article class="card' + (r.rank === 1 ? " is-top" : "") + '" id="card-' + esc(m.id) + '">' +
        '<header><span class="rank">#' + r.rank + "</span><h3>" + esc(m.model) + '</h3><span class="provider">' + esc(m.provider) + "</span>" +
        '<span class="card-score">' + r.total + "</span></header>" +
        '<dl class="breakdown">' + ["cost", "quality", "latency", "context", "privacy"].map(function (k) {
          return "<dt>" + COMPONENT_LABELS[k] + "</dt><dd>" + bar(c[k]) + " " + pct(c[k]) + "</dd>";
        }).join("") + "</dl>" +
        '<p><strong>Why this model:</strong> ' + esc(r.explain.why) + "</p>" +
        '<p><strong>Trade-offs:</strong> ' + esc(r.explain.tradeoffs) + "</p>" +
        '<p class="facts">' + "Price in/out per 1M tokens: " + fmtPrice(m.input_price_per_mtok) + " / " + fmtPrice(m.output_price_per_mtok) +
        ". Context: " + esc(fmtTokens(m.context_window)) + ". Speed: " + esc(m.latency_class || "not rated") +
        ". Quality tier: " + (m.quality_tier != null ? m.quality_tier + " of 5 (editorial)" : "not rated") +
        ". Open weights: " + (m.open_weights ? "yes" : "no") + ". Monthly: " + costCell(r, p) + ".</p>" +
        (m.strengths.length ? '<p class="facts"><strong>Strengths:</strong> ' + esc(m.strengths.join("; ")) + ".</p>" : "") +
        (m.limits.length ? '<p class="facts"><strong>Limits:</strong> ' + esc(m.limits.join("; ")) + ".</p>" : "") +
        (flags.length ? '<ul class="flags">' + flags.join("") + "</ul>" : "") +
        '<p class="source">Source: <a href="' + esc(safeUrl(m.source.url)) + '" rel="noopener">' + esc(m.source.name) + "</a>. " + dataBadge(m) + "</p>" +
        "</article>";
    }).join("");

    // excluded
    $("excluded").innerHTML = res.excluded.length ? res.excluded.map(function (r) {
      return "<li><strong>" + esc(r.model.model) + "</strong> (" + esc(r.model.provider) + "): " + esc(r.excludeReason) + "</li>";
    }).join("") : "<li>None. Every model passed the hard constraints.</li>";

    renderSwitchOptions();
    renderSwitch();
  }

  function renderSwitchOptions() {
    var sel = $("current-model"), prev = sel.value;
    var list = candidates().slice().sort(function (a, b) { return a.model.localeCompare(b.model); });
    if (sel.options.length === list.length + 1 && sel.dataset.n === String(list.length)) return;
    sel.innerHTML = '<option value="">Choose your current model</option>' + list.map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(m.model) + " (" + esc(m.provider) + ")</option>";
    }).join("");
    sel.dataset.n = String(list.length);
    sel.value = prev;
  }

  function renderSwitch() {
    var id = $("current-model").value, out = $("switch-result");
    if (!id) { out.innerHTML = "<p>Pick the model you use today. The check uses the profile and weights you set above.</p>"; return; }
    var r = switchCheck(candidates(), id, readProfile(), state.now);
    if (r.excluded) { out.innerHTML = '<p class="verdict warn">Your current model fails a hard constraint in this profile: ' + esc(r.excludeReason) + " Reconsider it now.</p>"; return; }
    if (!r.found) { out.innerHTML = "<p>That model is not in the current candidate list.</p>"; return; }
    var cur = r.current, html = "";
    html += "<p>" + esc(cur.model.model) + " scores <strong>" + cur.total + "</strong> and ranks #" + cur.rank + " under your weights.</p>";
    if (!r.better.length) html += '<p class="verdict ok">No catalog model beats it on your weights. Keep it, and re-run this check when prices or your needs change.</p>';
    else {
      html += '<p class="verdict ' + (r.worthSwitching ? "warn" : "ok") + '">' + r.better.length + " model" + (r.better.length > 1 ? "s beat" : " beats") + " it. " +
        (r.worthSwitching ? "The best challenger wins by " + r.better[0].margin + " points, at or above the " + SWITCH_MARGIN + " point switch threshold: worth a trial." :
          "The best challenger wins by only " + r.better[0].margin + " points, under the " + SWITCH_MARGIN + " point threshold: not worth a migration on score alone.") + "</p>";
      html += "<ol>" + r.better.slice(0, 5).map(function (b) {
        return "<li>" + esc(b.model.model) + " (" + esc(b.model.provider) + "): +" + b.margin + " points</li>";
      }).join("") + "</ol>";
    }
    if (r.stale && r.stale.stale) html += '<p class="verdict warn">Spec warning: ' + esc(r.stale.reason) + " Re-check its pricing page before trusting this comparison.</p>";
    out.innerHTML = html;
  }

  function renderStatus() {
    var c = state.catalog, st = staleStatus({ last_verified: c.catalog_date }, state.now, c.stale_after_days);
    var html = '<p><strong>Bundled catalog dated ' + esc(c.catalog_date) + "</strong> (" + state.base.length + " models, " +
      (st.ageDays != null ? st.ageDays + " days old" : "age unknown") + ", loaded from " + esc(state.catalogOrigin) + "). ";
    if (st.stale) html += '<span class="badge stale">Stale</span> This catalog is older than ' + c.stale_after_days + " days. Treat prices as possibly out of date. ";
    html += "</p>";
    var L = state.live;
    if (!L) html += '<p class="muted">Checking OpenRouter for live prices...</p>';
    else if (L.ok) {
      html += '<p><span class="badge live">Live</span> OpenRouter model list fetched ' + esc(L.fetchedAt.toLocaleString()) +
        ": " + L.matched + " catalog models updated with live prices" + (L.changed.length ? " (" + L.changed.length + " changed since the bundled snapshot)" : ", none changed since the bundled snapshot") +
        ". " + L.liveOnly + " other live models are available with the checkbox above the results.</p>";
    } else {
      html += '<p><span class="badge warn">Offline</span> Live data unavailable (' + esc(L.error) + "). Using the bundled catalog dated " + esc(c.catalog_date) + ".</p>";
    }
    $("data-status").innerHTML = html;
    $("include-live").disabled = !(L && L.ok);
  }

  function applySuggestions() {
    var s = suggestFromText($("task-desc").value);
    var out = $("suggest-result");
    if (!s.why.length) { out.textContent = "No keywords matched. Set the fields below by hand."; return; }
    var st = s.settings;
    if (st.taskType) $("task-type").value = st.taskType;
    if (st.modality) $("modality").value = st.modality;
    if (st.localOnly) $("local-only").checked = true;
    if (st.budget) $("budget").value = st.budget;
    if (st.latency) $("latency").value = st.latency;
    if (st.quality) $("quality").value = st.quality;
    if (st.contextNeed) $("context-need").value = String(st.contextNeed);
    out.textContent = "Updated settings because your description " + s.why.join(", ") + ". This is simple keyword matching: check the fields.";
    render();
  }

  function loadCatalog() {
    function fromEmbedded(why) {
      var el = $("embedded-catalog");
      state.catalogOrigin = "the copy embedded in index.html (" + why + ")";
      return JSON.parse(el.textContent);
    }
    if (typeof fetch !== "function" || location.protocol === "file:") {
      return Promise.resolve(fromEmbedded(location.protocol === "file:" ? "opened as a local file" : "fetch unavailable"));
    }
    return fetch("catalog.json", { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) { state.catalogOrigin = "catalog.json"; return j; })
      .catch(function (e) { return fromEmbedded("catalog.json failed: " + e.message); });
  }

  function loadLive() {
    if (typeof fetch !== "function") { state.live = { ok: false, error: "this browser cannot fetch" }; return Promise.resolve(); }
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
    return fetch(OPENROUTER_URL, ctrl ? { signal: ctrl.signal } : {}).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (j) {
      if (!j || !Array.isArray(j.data)) throw new Error("unexpected response format");
      var at = new Date();
      var m = mergeLive(state.catalog.models, j.data, at);
      state.base = m.models;
      state.liveOnly = m.liveOnly;
      state.live = { ok: true, fetchedAt: at, matched: m.matched, changed: m.changed, liveOnly: m.liveOnly.length };
    }).catch(function (e) {
      state.live = { ok: false, error: e && e.name === "AbortError" ? "timed out" : "blocked, offline, or failed: " + (e && e.message ? e.message : "unknown error") };
    }).then(function () { clearTimeout(timer); });
  }

  function init() {
    var form = $("profile");
    form.addEventListener("input", render);
    form.addEventListener("change", render);
    form.addEventListener("submit", function (e) { e.preventDefault(); render(); });
    $("suggest").addEventListener("click", applySuggestions);
    $("include-live").addEventListener("change", render);
    $("current-model").addEventListener("change", renderSwitch);
    loadCatalog().then(function (cat) {
      state.catalog = cat;
      state.base = cat.models.slice();
      $("catalog-date").textContent = cat.catalog_date;
      $("stale-days").textContent = String(cat.stale_after_days || STALE_AFTER_DAYS);
      renderStatus();
      render();
      return loadLive().then(function () { renderStatus(); render(); });
    }).catch(function (e) {
      $("data-status").innerHTML = '<p class="verdict warn">Could not load the model catalog (' + esc(e.message) + "). Try serving the folder with python3 -m http.server.</p>";
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(this);
