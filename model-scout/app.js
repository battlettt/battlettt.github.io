/* Model Scout v2: client-side ranking engine and UI.
   The engine functions are pure and exported for node tests (tests/run_tests.js).
   The UI code only runs in a browser. The ranker calls no model: it fetches catalog.json
   (same folder) and the public OpenRouter model list. Only the "Ask a model" panel calls a
   model, when the user presses Send: OpenRouter chat with the user's own key (kept in
   localStorage, never in this repo), or Ollama on localhost with no key. */
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
  var CAPABILITIES = ["tools", "json", "reasoning"];
  var CAPABILITY_LABELS = { tools: "tool calling", json: "JSON output", reasoning: "reasoning mode" };
  var MAX_CACHE_SHARE = 0.95;
  var ROBUST_SAMPLES = 300;
  var ROBUST_SPREAD = Math.log(2); // each weight is scaled by a factor between 1/2 and 2
  var NEW_WINDOW_DAYS = 30; // "new" in the market watch means first listed within this many days
  var TIP_EDGE = 0.0005; // tipping points within 0.05 points of 0% or 100% are ties at the edge, not reported
  var DAYS_PER_MONTH = 365 / 12;

  // ---------- small helpers ----------
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function isNum(x) { return typeof x === "number" && isFinite(x); }
  function round(x, d) { var p = Math.pow(10, d || 0); return Math.round(x * p) / p; }

  // ---------- cost math ----------
  /**
   * Prices per million tokens after the profile's batch and cache options. Null when a list price is unknown.
   * opts: { useBatch, cacheShare, inputTokens, outputTokens }. A batch price is used only when it is listed and
   * not higher than the standard price. Cached input is billed at the cache read price for cacheShare of the
   * input tokens. The two are not combined: when both apply, the one that costs less for the token mix wins
   * (3:1 input to output when no volume is given), and batchSkipped says the cache won. Cache write fees are
   * not modelled.
   */
  function effectivePrices(model, opts) {
    var pin = model.input_price_per_mtok, pout = model.output_price_per_mtok;
    if (!isNum(pin) || !isNum(pout)) return null;
    var o = opts || {}, r = { input: pin, output: pout, batch: false, cache: false };
    var bi = model.batch_input_price_per_mtok, bo = model.batch_output_price_per_mtok;
    var batchOk = !!o.useBatch && isNum(bi) && isNum(bo) && bi <= pin && bo <= pout;
    var share = isNum(o.cacheShare) ? clamp(o.cacheShare, 0, MAX_CACHE_SHARE) : 0;
    var cr = model.cache_read_price_per_mtok;
    var cacheOk = share > 0 && isNum(cr) && cr < pin, cacheIn = cacheOk ? (1 - share) * pin + share * cr : pin;
    if (batchOk && cacheOk) {
      var tin = isNum(o.inputTokens) && o.inputTokens > 0 ? o.inputTokens : 3, tout = isNum(o.outputTokens) && o.outputTokens >= 0 ? o.outputTokens : 1;
      if (isNum(o.inputTokens) && o.inputTokens > 0 && !isNum(o.outputTokens)) tout = 0;
      if (cacheIn * tin + pout * tout < bi * tin + bo * tout) { batchOk = false; r.batchSkipped = true; }
      else cacheOk = false;
    }
    if (batchOk) { r.input = bi; r.output = bo; r.batch = true; }
    else if (cacheOk) { r.input = cacheIn; r.cache = true; }
    return r;
  }

  /** Monthly cost in USD. Prices are per million tokens. Returns null if a price is unknown. opts as in effectivePrices. */
  function monthlyCost(model, inputTokens, outputTokens, opts) {
    var e = effectivePrices(model, opts);
    if (!e) return null;
    return (inputTokens / 1e6) * e.input + (outputTokens / 1e6) * e.output;
  }

  /** Blended $/M for the user's input/output mix. Defaults to a 3:1 input:output mix. */
  function blendedPrice(model, inputTokens, outputTokens, opts) {
    var e = effectivePrices(model, opts);
    if (!e) return null;
    var i = inputTokens > 0 ? inputTokens : 0, o = outputTokens > 0 ? outputTokens : 0;
    if (i + o === 0) { i = 3; o = 1; }
    return (i * e.input + o * e.output) / (i + o);
  }

  /** Monthly volume in millions of tokens from requests per day and tokens per request. A month is 365/12 days. */
  function volumeFromRequests(perDay, inPerRequest, outPerRequest) {
    function n(x) { return isNum(x) && x > 0 ? x : 0; }
    var requests = n(perDay) * DAYS_PER_MONTH;
    return { requests: requests, inputM: requests * n(inPerRequest) / 1e6, outputM: requests * n(outPerRequest) / 1e6 };
  }

  // ---------- token estimate from a pasted sample ----------
  // Rough on purpose: about 4 characters per token for English and code, about 1 per CJK character.
  // Runs of spaces or tabs count once. A provider's tokenizer gives the real number.
  var CJK_CHARS = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;
  var CACHE_MIN_TOKENS = 1024;

  function estimateTokens(text) {
    var t = typeof text === "string" ? text.replace(/[ \t]{2,}/g, " ").trim() : "";
    if (!t) return { tokens: 0, chars: 0, cjk: 0 };
    var cjk = (t.match(CJK_CHARS) || []).length;
    return { tokens: Math.max(1, Math.ceil((t.length - cjk) / 4 + cjk)), chars: t.length, cjk: cjk };
  }

  /** Tokens per request from samples: fixed = text repeated on every request (instructions, shared documents),
   *  variable = the part that changes, reply = a typical answer. cacheShare is the largest cache option at or
   *  below the repeated share, and 0 when the repeated part is shorter than CACHE_MIN_TOKENS. */
  function sampleEstimate(fixed, variable, reply) {
    var f = estimateTokens(fixed).tokens, v = estimateTokens(variable).tokens, r = estimateTokens(reply).tokens;
    var input = f + v, share = input > 0 ? f / input : 0, cache = 0, tooShort = f > 0 && f < CACHE_MIN_TOKENS;
    if (!tooShort) SETTING_CHOICES.cacheShare.forEach(function (o) { if (o <= share + 1e-9) cache = o; });
    return { fixed: f, variable: v, input: input, output: r, repeatedShare: share, cacheShare: cache, cacheTooShort: tooShort };
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
    // optional fields, filled from OpenRouter's model list when the model is listed there
    ["cache_read_price_per_mtok", "batch_input_price_per_mtok", "batch_output_price_per_mtok", "max_output_tokens"].forEach(function (f) {
      if (e[f] != null && (!isNum(e[f]) || e[f] < 0)) errs.push(f + " must be a non-negative number or null");
    });
    if ((e.batch_input_price_per_mtok == null) !== (e.batch_output_price_per_mtok == null)) errs.push("batch prices must be both set or both null");
    if (e.capabilities != null) {
      if (typeof e.capabilities !== "object" || Array.isArray(e.capabilities)) errs.push("capabilities must be an object or null");
      else CAPABILITIES.forEach(function (k) { if (typeof e.capabilities[k] !== "boolean") errs.push("capabilities." + k + " must be true or false"); });
    }
    if (e.retires_on != null && parseDate(e.retires_on) === null) errs.push("retires_on must be a YYYY-MM-DD date or null");
    return errs;
  }

  /** Scheduled retirement from the listed expiration date, or null when none is listed. */
  function retirement(e, now) {
    var t = parseDate(e && e.retires_on);
    if (t === null) return null;
    var nowMs = now instanceof Date ? now.getTime() : (isNum(now) ? now : Date.now());
    var days = Math.ceil((t - nowMs) / DAY_MS), d = String(e.retires_on).slice(0, 10);
    if (days < 0) return { days: days, past: true, text: "Retired on " + d + ", the expiration date OpenRouter lists. Move off it." };
    return { days: days, past: false, text: "Scheduled to retire on " + d + (days === 0 ? " (today)" : " (in " + days + " day" + (days === 1 ? "" : "s") + ")") + ": plan the move now." };
  }

  /** Every flag the UI should show for an entry's data quality. */
  function dataFlags(e, now) {
    var flags = [];
    var st = staleStatus(e, now);
    if (st.stale) flags.push({ level: "warn", text: "Stale: " + st.reason });
    var ret = retirement(e, now);
    if (ret) flags.push({ level: "warn", text: ret.text });
    if (e.price_status === "unverified") flags.push({ level: "warn", text: "Price not verified: the figure shown is not confirmed by a current source." });
    if (e.unverified_fields && e.unverified_fields.length) {
      flags.push({ level: "warn", text: "Not verified: " + e.unverified_fields.join(", ").replace(/_/g, " ") + "." });
    }
    if (e.quality_tier == null) flags.push({ level: "info", text: "Quality not rated: this model came from live data and has no editorial tier." });
    if (e.latency_class == null) flags.push({ level: "info", text: "Speed not rated." });
    return flags;
  }

  // ---------- weights ----------
  var FACTORS = ["cost", "quality", "latency", "context", "privacy"];

  /** Hand-set weights as shares that sum to 1, or null when they are missing, negative, or all zero. */
  function normalizeWeights(raw) {
    if (!raw || typeof raw !== "object") return null;
    var out = {}, sum = 0;
    for (var i = 0; i < FACTORS.length; i++) {
      var v = raw[FACTORS[i]];
      if (!isNum(v) || v < 0) return null;
      out[FACTORS[i]] = v; sum += v;
    }
    if (!(sum > 0)) return null;
    FACTORS.forEach(function (k) { out[k] = out[k] / sum; });
    return out;
  }

  /** Weights respond to the user's constraints and always sum to 1. Hand-set weights (p.weights) replace them. */
  function computeWeights(p) {
    var custom = normalizeWeights(p && p.weights);
    if (custom) return custom;
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
    if (!isEmbedTask) {
      for (var ci = 0; ci < CAPABILITIES.length; ci++) {
        var ck = CAPABILITIES[ci], label = CAPABILITY_LABELS[ck];
        if (!(p.needs && p.needs[ck])) continue;
        if (m.capabilities && m.capabilities[ck] === false) return excl(r, "Does not support " + label + " (OpenRouter's model list), and your profile requires it.");
        if (!m.capabilities) r.flags.push(label.charAt(0).toUpperCase() + label.slice(1) + " not confirmed: no capability data for this model.");
      }
    }

    var c = r.components;
    // cost
    if (p.localOnly) {
      var hw = m.local_hardware || "unknown";
      c.cost = HARDWARE_SCORE[hw] != null ? HARDWARE_SCORE[hw] : HARDWARE_SCORE.unknown;
      r.notes.push("Self-hosted: needs " + (HARDWARE_LABEL[hw] || HARDWARE_LABEL.unknown) + ". Cost score reflects hardware size, not a per-token price.");
    } else {
      var b = blendedPrice(m, p.inputTokens, p.outputTokens, p);
      if (b === null) { c.cost = 0.5; r.flags.push("Price unknown, so cost was scored as average."); }
      else {
        c.cost = costScoreFromPrice(b);
        if (isNum(p.budget) && p.budget > 0 && b > p.budget) {
          c.cost *= 0.25;
          r.flags.push("Over budget: about $" + round(b, 3) + " per million tokens for your mix, above your $" + p.budget + " limit.");
        }
        costNotes(r, m, p);
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

  /** Notes on how the batch and cache options changed this model's price. */
  function costNotes(r, m, p) {
    var e = effectivePrices(m, p);
    if (!e) return;
    if (p.useBatch) {
      r.notes.push(e.batch ? "Batch price used: " + fmtPrice(e.input) + " in / " + fmtPrice(e.output) + " out per 1M tokens, for work that can wait for a batch run." :
        e.batchSkipped ? "A lower batch price is listed, but the prompt cache costs less for your mix, so cached pricing is used instead." :
        "No lower batch price is listed for this model, so the standard price is used.");
    }
    if (isNum(p.cacheShare) && p.cacheShare > 0 && !e.batch) {
      r.notes.push(e.cache ? "Cached input billed at " + fmtPrice(m.cache_read_price_per_mtok) + " per 1M for " + Math.round(clamp(p.cacheShare, 0, MAX_CACHE_SHARE) * 100) + "% of input tokens. Cache write fees are not included." :
        "No cache read price is listed, so all input is billed at the full input price.");
    }
  }

  /** Rank all models. Ties are broken by lower monthly cost, then by name. */
  function rankModels(models, p, now) {
    var w = computeWeights(p);
    var all = models.map(function (m) { return scoreModel(m, p, w, now); });
    var ranked = all.filter(function (r) { return !r.excluded; });
    ranked.sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      var ca = monthlyCost(a.model, p.inputTokens, p.outputTokens, p), cb = monthlyCost(b.model, p.inputTokens, p.outputTokens, p);
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
      var mc = monthlyCost(r.model, p.inputTokens, p.outputTokens, p), oc = monthlyCost(other.model, p.inputTokens, p.outputTokens, p);
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
      stale: staleStatus(cur.model, now), retirement: retirement(cur.model, now)
    };
  }

  // ---------- robustness of the top pick ----------
  /** Small seeded random number generator (mulberry32), so the same profile always gives the same answer. */
  function seededRandom(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * How often does each model come first when the weights are nudged at random? Each sample scales every
   * weight by a factor between 1/2 and 2, renormalises, and rescores every ranked model with the same
   * factor scores. Ties go to the higher-ranked model. Returns null when nothing is ranked.
   * runnerUp says whether the second model ties the top pick on every factor (no weighting can separate
   * them) or is matched or beaten on every factor (no weighting can put it first).
   */
  function robustness(res, opts) {
    opts = opts || {};
    var ranked = res && res.ranked;
    if (!ranked || !ranked.length) return null;
    var n = opts.samples || ROBUST_SAMPLES, spread = isNum(opts.spread) ? opts.spread : ROBUST_SPREAD;
    var w = res.weights, keys = Object.keys(w), rnd = seededRandom(opts.seed || 20261113);
    var wins = ranked.map(function () { return 0; });
    for (var s = 0; s < n; s++) {
      var ws = {}, sum = 0;
      keys.forEach(function (k) { ws[k] = w[k] * Math.exp(spread * (2 * rnd() - 1)); sum += ws[k]; });
      var best = 0, bestV = -Infinity;
      for (var i = 0; i < ranked.length; i++) {
        var r = ranked[i], v = 0;
        for (var j = 0; j < keys.length; j++) v += (ws[keys[j]] / sum) * r.components[keys[j]];
        v *= r.fit;
        if (v > bestV + 1e-12) { bestV = v; best = i; }
      }
      wins[best]++;
    }
    var shares = ranked.map(function (r, i) { return { model: r.model, rank: r.rank, share: wins[i] / n }; })
      .filter(function (x) { return x.share > 0; })
      .sort(function (a, b) { return b.share - a.share || a.rank - b.rank; });
    var topShare = wins[0] / n, runnerUp = null;
    if (ranked[1]) {
      var a = ranked[0], b = ranked[1], ge = true, eq = true;
      keys.forEach(function (k) {
        var x = a.components[k] * a.fit, y = b.components[k] * b.fit;
        if (x < y - 1e-9) ge = false;
        if (Math.abs(x - y) > 1e-9) eq = false;
      });
      runnerUp = { model: b.model, twin: eq, dominated: ge && !eq };
    }
    return {
      samples: n, topShare: topShare, shares: shares, runnerUp: runnerUp,
      verdict: runnerUp && runnerUp.twin ? "tie" : topShare >= 0.8 ? "stable" : topShare >= 0.5 ? "likely" : "close"
    };
  }

  // ---------- tipping points: how far each weight can move before the pick changes ----------
  /** Weights with one factor's share set to t and the others scaled to keep their proportions. */
  function weightsAt(w, key, t) {
    var rest = 1 - w[key], out = {};
    t = clamp(t, 0, 1);
    Object.keys(w).forEach(function (k) {
      if (k === key) out[k] = t;
      else out[k] = rest > 1e-12 ? w[k] * (1 - t) / rest : (1 - t) / (Object.keys(w).length - 1);
    });
    return out;
  }

  /** Shares as whole percentages that add up to exactly 100 (largest remainder). */
  function sharesToPercents(w) {
    var keys = Object.keys(w), floors = {}, used = 0;
    keys.forEach(function (k) { floors[k] = Math.floor(w[k] * 100); used += floors[k]; });
    keys.slice().sort(function (a, b) { return (w[b] * 100 - floors[b]) - (w[a] * 100 - floors[a]); })
      .slice(0, Math.max(0, 100 - used)).forEach(function (k) { floors[k]++; });
    return floors;
  }

  /**
   * Exact tipping points for the top pick. Move one factor's weight share up or down, with the other weights
   * keeping their proportions, and find the nearest share at which another model comes first. Every score is
   * a straight line in that share, so each crossing is solved exactly rather than sampled.
   * Returns null when nothing is ranked; { near: true, model } when a rival is already level with the top pick
   * before rounding; otherwise { factors: [{ key, share, up, down }], nearest }, where up and down are
   * { share, model } or null when no share in that direction changes the pick, and nearest is the closest
   * tipping point of all ({ key, dir, from, share, model }) or null.
   */
  function tippingPoints(res) {
    var ranked = res && res.ranked;
    if (!ranked || !ranked.length) return null;
    var w = res.weights, keys = Object.keys(w), top = ranked[0], EPS = 1e-9;
    function exact(r) { var v = 0; keys.forEach(function (k) { v += w[k] * r.components[k]; }); return v * r.fit; }
    var lead = exact(top);
    for (var i = 1; i < ranked.length; i++) {
      if (exact(ranked[i]) < lead - EPS) continue;
      var rival = ranked[i], twin = keys.every(function (k) { return Math.abs(top.components[k] * top.fit - rival.components[k] * rival.fit) <= EPS; });
      return { near: true, twin: twin, model: rival.model, factors: [], nearest: null };
    }
    var nearest = null;
    var factors = keys.map(function (k) {
      var wk = w[k], out = { key: k, share: wk, up: null, down: null };
      if (wk >= 1 - EPS || ranked.length < 2) return out;
      function line(r) {
        var rest = 0;
        keys.forEach(function (j) { if (j !== k) rest += w[j] * r.components[j]; });
        rest = rest / (1 - wk);
        return { a: r.fit * rest, b: r.fit * (r.components[k] - rest) };
      }
      var T = line(top), up = null, down = null;
      for (var n = 1; n < ranked.length; n++) {
        var L = line(ranked[n]), db = L.b - T.b;
        if (Math.abs(db) < 1e-12) continue;
        var t = (T.a - L.a) / db;
        // A crossing at the very end of the range (all or none of the weight) is a tie there, not a change of pick.
        if (db > 0 && t > wk + EPS && t <= 1 - TIP_EDGE) {
          if (!up || t < up.t - EPS || (Math.abs(t - up.t) <= EPS && L.b > up.b)) up = { t: t, b: L.b, model: ranked[n].model };
        } else if (db < 0 && t < wk - EPS && t >= TIP_EDGE) {
          if (!down || t > down.t + EPS || (Math.abs(t - down.t) <= EPS && L.b < down.b)) down = { t: t, b: L.b, model: ranked[n].model };
        }
      }
      if (up) out.up = { share: up.t, model: up.model };
      if (down) out.down = { share: down.t, model: down.model };
      [["up", out.up], ["down", out.down]].forEach(function (d) {
        if (d[1] && (!nearest || Math.abs(d[1].share - wk) < Math.abs(nearest.share - nearest.from))) {
          nearest = { key: k, dir: d[0], from: wk, share: d[1].share, model: d[1].model };
        }
      });
      return out;
    });
    return { near: false, single: ranked.length < 2, factors: factors, nearest: nearest };
  }

  /** A share as a percentage, with one decimal when it would otherwise round to the same figure as ref. */
  function shareLabel(t, ref) {
    var a = Math.round(t * 100);
    return (isNum(ref) && a === Math.round(ref * 100) ? (t * 100).toFixed(1) : String(a)) + "%";
  }

  /** One sentence on the nearest tipping point, for the memo and the results panel. */
  function tipSentence(tp) {
    if (!tp) return "";
    if (tp.near && tp.twin) return "Ties " + tp.model.model + " on every factor, so no weighting separates them.";
    if (tp.near) return "Level with " + tp.model.model + " before rounding, so a small change in the weights can swap them.";
    if (tp.single) return "Only one model passes the hard constraints, so no weighting changes the pick.";
    var n = tp.nearest;
    if (!n) return "No single weight, moved anywhere from 0% to 100%, puts another model first.";
    return "The pick changes soonest if the weight on " + COMPONENT_LABELS[n.key] + " " + (n.dir === "up" ? "rises" : "falls") +
      " from " + shareLabel(n.from, n.share) + " to " + shareLabel(n.share, n.from) + ". Then " + n.model.model + " comes first.";
  }

  /**
   * Whole-percent weights just past one tipping point, checked by re-ranking: the smallest step past the
   * crossing (up to 5 points) at which a different model comes first. Returns { weights, model } or null.
   */
  function tipWeights(models, p, now, key, dir) {
    var res = rankModels(models, p, now), tp = tippingPoints(res);
    if (!tp || tp.near) return null;
    var f = null;
    tp.factors.forEach(function (x) { if (x.key === key) f = x; });
    var tip = f && f[dir];
    if (!tip) return null;
    var topId = res.ranked[0].model.id, sign = dir === "up" ? 1 : -1;
    for (var step = 1; step <= 10; step++) {
      var t = clamp(tip.share + sign * step * 0.005, 0, 1);
      var whole = sharesToPercents(weightsAt(res.weights, key, t));
      var q = {}; Object.keys(p).forEach(function (k2) { q[k2] = p[k2]; });
      q.weights = whole;
      var r2 = rankModels(models, q, now);
      if (r2.ranked[0] && r2.ranked[0].model.id !== topId) return { weights: whole, model: r2.ranked[0].model };
    }
    return null;
  }

  // ---------- value map: score against monthly cost ----------
  /** Pareto frontier for "higher score, lower cost": ids of points that no other point beats on both, in cost order. */
  function frontier(points) {
    var best = -Infinity, out = [];
    (points || []).filter(function (q) { return q && isNum(q.cost) && isNum(q.score); }).slice()
      .sort(function (a, b) { return a.cost - b.cost || b.score - a.score; })
      .forEach(function (q) { if (q.score > best) { out.push(q.id); best = q.score; } });
    return out;
  }

  /** The cheapest ranked model within `gap` points (default 5) of the top pick that costs less per month, or null. */
  function cheaperAlternative(ranked, p, gap) {
    if (!ranked || ranked.length < 2 || p.localOnly) return null;
    var g = isNum(gap) ? gap : SWITCH_MARGIN, top = ranked[0];
    var topCost = monthlyCost(top.model, p.inputTokens, p.outputTokens, p);
    if (topCost === null || topCost <= 0) return null;
    var best = null;
    ranked.slice(1).forEach(function (r) {
      if (top.total - r.total > g) return;
      var c = monthlyCost(r.model, p.inputTokens, p.outputTokens, p);
      if (c === null || topCost - c < 0.01) return;
      if (!best || c < best.cost || (c === best.cost && r.total > best.r.total)) best = { r: r, cost: c };
    });
    if (!best) return null;
    return { model: best.r.model, total: best.r.total, rank: best.r.rank, cost: best.cost, topCost: topCost,
      saves: topCost - best.cost, gap: round(top.total - best.r.total, 1) };
  }

  /**
   * SVG for the value map. points: [{ id, name, cost, score, top }]. Cost uses a log scale; points with no cost
   * are left out and counted. Pure string output, so it can be tested without a browser.
   */
  function valueMapSvg(points, opts) {
    opts = opts || {};
    // Drawn at the container's own width so 12px text stays 12px on a phone; 720 wide when the width is unknown.
    var W = isNum(opts.width) && opts.width > 0 ? Math.round(clamp(opts.width, 300, 1100)) : 720;
    var H = W < 560 ? Math.round(W * 0.8) : Math.round(clamp(W * 0.48, 300, 400)), L = 56, R = 20, T = 18, B = 52;
    var pts = (points || []).filter(function (q) { return isNum(q.cost) && isNum(q.score); });
    if (!pts.length) return { svg: "", plotted: 0, skipped: (points || []).length, frontier: [] };
    var pos = pts.map(function (q) { return q.cost; }).filter(function (c) { return c > 0; });
    var minPos = pos.length ? Math.min.apply(null, pos) : 1;
    var floor = minPos / 2;
    var lo = Math.log10(Math.max(floor, 1e-6)), hi = Math.log10(Math.max(Math.max.apply(null, pts.map(function (q) { return q.cost; })), minPos));
    lo = Math.floor(lo * 2) / 2; hi = Math.ceil(hi * 2) / 2;
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    var sMin = Math.min.apply(null, pts.map(function (q) { return q.score; }));
    var yLo = Math.max(0, Math.floor((sMin - 5) / 10) * 10), yHi = 100;
    function x(c) { return L + (Math.log10(Math.max(c, floor)) - lo) / (hi - lo) * (W - L - R); }
    function y(s) { return T + (yHi - s) / (yHi - yLo) * (H - T - B); }
    function f1(v) { return Math.round(v * 10) / 10; }
    var front = frontier(pts), onFront = {};
    front.forEach(function (id) { onFront[id] = true; });
    var out = [];
    // grid and axes
    for (var g = yLo; g <= yHi; g += 10) {
      out.push('<line class="vm-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + f1(y(g)) + '" y2="' + f1(y(g)) + '"/>');
      out.push('<text class="vm-tick" x="' + (L - 8) + '" y="' + f1(y(g) + 4) + '" text-anchor="end">' + g + "</text>");
    }
    for (var d = Math.ceil(lo); d <= Math.floor(hi); d++) {
      var xv = f1(x(Math.pow(10, d)));
      out.push('<line class="vm-grid" x1="' + xv + '" x2="' + xv + '" y1="' + T + '" y2="' + (H - B) + '"/>');
      var tv = Math.pow(10, d);
      out.push('<text class="vm-tick" x="' + xv + '" y="' + (H - B + 18) + '" text-anchor="middle">' + (tv >= 1000 ? "$" + (tv / 1000) + "K" : "$" + String(round(tv, 4))) + "</text>");
    }
    out.push('<text class="vm-axis" x="' + ((L + W - R) / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + escapeHtml(opts.xLabel || "Monthly cost at your volume (log scale)") + "</text>");
    out.push('<text class="vm-axis" x="14" y="' + ((T + H - B) / 2) + '" text-anchor="middle" transform="rotate(-90 14 ' + ((T + H - B) / 2) + ')">Score</text>');
    // frontier staircase
    var fp = front.map(function (id) { return pts.filter(function (q) { return q.id === id; })[0]; });
    if (fp.length > 1) {
      var dPath = "M" + f1(x(fp[0].cost)) + " " + f1(y(fp[0].score));
      for (var i = 1; i < fp.length; i++) dPath += " H" + f1(x(fp[i].cost)) + " V" + f1(y(fp[i].score));
      out.push('<path class="vm-front" d="' + dPath + '"/>');
    }
    // points: others first, then the frontier, then the top pick on top
    var order = pts.slice().sort(function (a, b) { return (onFront[a.id] ? 1 : 0) - (onFront[b.id] ? 1 : 0) || (a.top ? 1 : 0) - (b.top ? 1 : 0); });
    order.forEach(function (q) {
      var cls = "vm-pt" + (onFront[q.id] ? " is-front" : "") + (q.top ? " is-top" : "");
      out.push('<circle class="' + cls + '" data-id="' + escapeHtml(q.id) + '" cx="' + f1(x(q.cost)) + '" cy="' + f1(y(q.score)) + '" r="' + (q.top ? 7 : onFront[q.id] ? 5.5 : 4.5) + '"><title>' +
        escapeHtml(q.name + ": score " + q.score + ", " + fmtMoney(q.cost) + " a month") + "</title></circle>");
    });
    // labels for frontier points and the top pick, skipped where they would collide
    var boxes = [];
    function free(bx) { return boxes.every(function (o) { return bx.x2 < o.x1 || bx.x1 > o.x2 || bx.y2 < o.y1 || bx.y1 > o.y2; }); }
    pts.filter(function (q) { return onFront[q.id] || q.top; }).sort(function (a, b) { return (b.top ? 1 : 0) - (a.top ? 1 : 0); }).forEach(function (q) {
      var px = x(q.cost), py = y(q.score), w = q.name.length * 6.6 + 4, tries = [[10, -8, "start"], [-10, -8, "end"], [10, 16, "start"], [-10, 16, "end"]];
      for (var k = 0; k < tries.length; k++) {
        var t = tries[k], lx = px + t[0], ly = py + t[1];
        var bx = t[2] === "start" ? { x1: lx, x2: lx + w } : { x1: lx - w, x2: lx };
        bx.y1 = ly - 11; bx.y2 = ly + 3;
        if (bx.x1 < L || bx.x2 > W - 4 || bx.y1 < 0 || bx.y2 > H - B) continue;
        if (!free(bx)) continue;
        boxes.push(bx);
        out.push('<text class="vm-label' + (q.top ? " is-top" : "") + '" x="' + f1(lx) + '" y="' + f1(ly) + '" text-anchor="' + t[2] + '">' + escapeHtml(q.name) + "</text>");
        break;
      }
    });
    var title = opts.title || "Value map: score against monthly cost";
    var desc = pts.length + " models plotted. The frontier, from cheapest up: " +
      fp.map(function (q) { return q.name + " (score " + q.score + ", " + fmtMoney(q.cost) + ")"; }).join("; ") + ".";
    var svg = '<svg class="vm-svg" viewBox="0 0 ' + W + " " + H + '" role="img" aria-labelledby="vm-title vm-desc">' +
      '<title id="vm-title">' + escapeHtml(title) + '</title><desc id="vm-desc">' + escapeHtml(desc) + "</desc>" + out.join("") + "</svg>";
    return { svg: svg, plotted: pts.length, skipped: (points || []).length - pts.length, frontier: front };
  }

  // ---------- head to head ----------
  /** Rows for comparing a few ranked results side by side. best lists the column indexes with the best figure. */
  function headToHead(results, p) {
    var cols = results || [];
    function numRow(label, better, get, fmt) {
      var vals = cols.map(get), cells = vals.map(function (v) { return v === null || v === undefined || (typeof v === "number" && !isFinite(v)) ? "unknown" : fmt(v); });
      var known = vals.filter(isNum), best = [];
      if (known.length > 1 && Math.max.apply(null, known) !== Math.min.apply(null, known)) {
        var target = better === "low" ? Math.min.apply(null, known) : Math.max.apply(null, known);
        vals.forEach(function (v, i) { if (v === target) best.push(i); });
      }
      return { label: label, cells: cells, best: best };
    }
    function textRow(label, get) { return { label: label, cells: cols.map(get), best: [] }; }
    var rows = [
      numRow("Score", "high", function (r) { return r.total; }, String),
      numRow("Monthly cost", "low", function (r) { return monthlyCost(r.model, p.inputTokens, p.outputTokens, p); }, fmtMoney)
    ];
    ["cost", "quality", "latency", "context", "privacy"].forEach(function (k) {
      rows.push(numRow(COMPONENT_LABELS[k].charAt(0).toUpperCase() + COMPONENT_LABELS[k].slice(1) + " score", "high", function (r) { return Math.round(r.components[k] * 100); }, String));
    });
    rows.push(numRow("Input price per 1M", "low", function (r) { return r.model.input_price_per_mtok; }, fmtPrice));
    rows.push(numRow("Output price per 1M", "low", function (r) { return r.model.output_price_per_mtok; }, fmtPrice));
    rows.push(numRow("Context window", "high", function (r) { return r.model.context_window; }, function (v) { return fmtTokens(v) + " tokens"; }));
    rows.push(numRow("Longest answer", "high", function (r) { return r.model.max_output_tokens; }, function (v) { return fmtTokens(v) + " tokens"; }));
    rows.push(numRow("Quality tier (editorial)", "high", function (r) { return r.model.quality_tier; }, function (v) { return v + " of 5"; }));
    rows.push(textRow("Speed class (editorial)", function (r) { return r.model.latency_class || "not rated"; }));
    CAPABILITIES.forEach(function (k) {
      rows.push(textRow(CAPABILITY_LABELS[k].charAt(0).toUpperCase() + CAPABILITY_LABELS[k].slice(1), function (r) {
        var c = r.model.capabilities;
        return r.model.kind === "embedding" ? "not applicable" : !c ? "no data" : c[k] ? "yes" : "no";
      }));
    });
    rows.push(textRow("Open weights", function (r) { return r.model.open_weights ? "yes" : "no"; }));
    return { columns: cols.map(function (r) { return r.model.model; }), rows: rows };
  }

  // ---------- decision memo ----------
  var MODALITY_LABELS = { text: "text only", image: "images", file: "files (PDF and similar)", audio: "audio", video: "video" };
  var QUALITY_LABELS = { basic: "basic", good: "good (most production work)", frontier: "frontier (hardest work)" };
  var LATENCY_LABELS = { balanced: "balanced", fast: "fast (real time)", any: "does not matter (batch jobs)" };

  function mdCell(s) { return String(s == null ? "" : s).replace(/\|/g, "/").replace(/\s+/g, " ").trim(); }
  function fmtVolume(t) { var m = t / 1e6; return (m >= 100 ? Math.round(m) : round(m, 2)) + " million"; }

  /** The profile in plain words, one item per requirement. */
  function requirementLines(p) {
    var needs = CAPABILITIES.filter(function (k) { return p.needs && p.needs[k]; }).map(function (k) { return CAPABILITY_LABELS[k]; });
    return [
      "Task: " + (TASK_LABELS[p.taskType] || p.taskType),
      "Input: " + (MODALITY_LABELS[p.modality] || p.modality),
      "Quality bar: " + (QUALITY_LABELS[p.quality] || p.quality),
      "Speed target: " + (LATENCY_LABELS[p.latency] || p.latency),
      "Longest input: " + fmtTokens(p.contextNeed) + " tokens",
      "Budget: " + (isNum(p.budget) ? "$" + p.budget + " per million tokens, blended" : "no limit"),
      "Privacy: " + (p.localOnly ? "local only, open weights on our own hardware" : "hosted providers allowed"),
      "Must support: " + (needs.length ? needs.join(", ") : "nothing beyond text generation"),
      "Weights: " + (p.weights ? "set by hand, " + FACTORS.map(function (k) { return COMPONENT_LABELS[k] + " " + Math.round(p.weights[k] * 100) + "%"; }).join(", ") : "from the profile"),
      "Volume: " + fmtVolume(p.inputTokens) + " input and " + fmtVolume(p.outputTokens) + " output tokens a month" +
        (p.cacheShare > 0 ? ", " + Math.round(p.cacheShare * 100) + "% of input from the prompt cache" : "") + (p.useBatch ? ", batch prices where offered" : "")
    ];
  }

  /**
   * A Markdown memo for the decision: requirements, the pick and why, confidence, a cheaper option, runners-up,
   * exclusions, caveats, and when to revisit. ctx: { res, p, description, rb, alt, tips, whatIf, now, catalogDate, liveAt, link }.
   */
  function decisionMemo(ctx) {
    var res = ctx.res, p = ctx.p, top = res.ranked[0], L = [];
    var day = (ctx.now instanceof Date ? ctx.now : new Date()).toISOString().slice(0, 10);
    var task = String(ctx.description || "").trim();
    L.push("# Model choice: " + (task ? mdCell(task) : (TASK_LABELS[p.taskType] || p.taskType)));
    L.push("");
    L.push("Prepared " + day + " with Model Scout. Data: catalog snapshot " + (ctx.catalogDate || "unknown") +
      (ctx.liveAt ? ", with live OpenRouter prices fetched " + ctx.liveAt : ", bundled prices only (live data was not loaded)") + ".");
    L.push("");
    L.push("## Requirements");
    requirementLines(p).forEach(function (x) { L.push("- " + x); });
    L.push("");
    if (!top) {
      L.push("## Recommendation");
      L.push("No model meets every hard constraint. Loosen one (local only, input type, or a required capability) and run it again.");
    } else {
      var mc = monthlyCost(top.model, p.inputTokens, p.outputTokens, p);
      L.push("## Recommendation: " + mdCell(top.model.model) + " (" + mdCell(top.model.provider) + ")");
      L.push("- Score " + top.total + " of 100" + (p.localOnly ? ", self-hosted (hosted reference " + fmtMoney(mc) + " a month)." : ", about " + fmtMoney(mc) + " a month at this volume."));
      L.push("- Why: " + top.explain.why);
      L.push("- Trade-offs: " + top.explain.tradeoffs);
      if (ctx.rb) {
        L.push("- Confidence: " + (ctx.rb.verdict === "tie" ? "tied on every factor with " + ctx.rb.runnerUp.model.model + "; either works." :
          { stable: "stable", likely: "likely", close: "close call" }[ctx.rb.verdict] + ", first in " + Math.round(ctx.rb.topShare * 100) + "% of " + ctx.rb.samples + " reruns with each weight between half and double."));
      }
      if (ctx.tips && !ctx.tips.single) L.push("- Tipping point: " + tipSentence(ctx.tips));
      if (ctx.alt) L.push("- Cheaper option within " + SWITCH_MARGIN + " points: " + ctx.alt.model.model + " scores " + ctx.alt.total + " for " + fmtMoney(ctx.alt.cost) + " a month, saving " + fmtMoney(ctx.alt.saves) + ".");
      var flags = dataFlags(top.model, ctx.now).map(function (f) { return f.text; }).concat(top.flags);
      flags.forEach(function (f) { L.push("- Check: " + f); });
      L.push("");
      L.push("## Shortlist");
      L.push("| Rank | Model | Score | Monthly cost | Price in / out per 1M | Context |");
      L.push("| --- | --- | --- | --- | --- | --- |");
      res.ranked.slice(0, 5).forEach(function (r) {
        L.push("| " + r.rank + " | " + mdCell(r.model.model + " (" + r.model.provider + ")") + " | " + r.total + " | " +
          fmtMoney(monthlyCost(r.model, p.inputTokens, p.outputTokens, p)) + " | " + fmtPrice(r.model.input_price_per_mtok) + " / " + fmtPrice(r.model.output_price_per_mtok) + " | " + fmtTokens(r.model.context_window) + " |");
      });
    }
    if (ctx.whatIf && ctx.whatIf.levers.length) {
      L.push("");
      L.push("## If one constraint changed");
      ctx.whatIf.levers.slice(0, 5).forEach(function (lv) {
        var out = !lv.top ? "nothing passes every hard constraint" :
          (lv.pickChanged ? mdCell(lv.top.model) + " comes first" : "same pick") +
          (lv.selfHosted ? ", self-hosted (the cost is hardware)" : lv.delta === null ? (isNum(lv.cost) ? ", about " + fmtMoney(lv.cost) + " a month" : "") :
            lv.delta < 0 ? ", " + fmtMoney(-lv.delta) + " a month less (" + fmtMoney(lv.cost) + ")" :
            lv.delta > 0 ? ", " + fmtMoney(lv.delta) + " a month more (" + fmtMoney(lv.cost) + ")" : ", same monthly cost");
        L.push("- " + lv.label + ": " + out + ".");
      });
    }
    L.push("");
    L.push("## Ruled out");
    if (!res.excluded.length) L.push("- Nothing: every model passed the hard constraints.");
    else {
      res.excluded.slice(0, 6).forEach(function (r) { L.push("- " + mdCell(r.model.model) + ": " + r.excludeReason); });
      if (res.excluded.length > 6) L.push("- And " + (res.excluded.length - 6) + " more.");
    }
    L.push("");
    L.push("## Caveats");
    L.push("- Quality tiers and speed classes are editorial, from each provider's own positioning. They are not benchmark scores.");
    L.push("- Prices are OpenRouter's listed figures. Buying direct can differ. Cache write fees are not included.");
    L.push("- Run the shortlist on 50 or more of your own examples before you commit.");
    L.push("");
    L.push("## Revisit when");
    L.push("- A challenger beats this pick by " + SWITCH_MARGIN + " points or more on the same profile.");
    L.push("- Prices change, the spec is older than " + STALE_AFTER_DAYS + " days, or the provider announces a retirement date.");
    L.push("- Inputs get longer, a new input type or capability is needed, or volume grows tenfold.");
    if (ctx.link) { L.push(""); L.push("Settings: " + ctx.link); }
    return L.join("\n") + "\n";
  }

  // ---------- live data (OpenRouter) ----------
  function perMillion(x) { var v = parseFloat(x); return isFinite(v) ? round(v * 1e6, 4) : null; }

  /**
   * Facts beyond price from one OpenRouter list entry: capabilities (from supported_parameters), cache read
   * price, batch prices (from the ":batch" variant), output limit, retirement date, and listing date.
   * Every key is present; null means OpenRouter does not list it.
   */
  function liveFacts(m, byId) {
    var f = { capabilities: null, cache_read_price_per_mtok: null, batch_input_price_per_mtok: null,
      batch_output_price_per_mtok: null, max_output_tokens: null, retires_on: null, listed_on: null };
    if (!m) return f;
    var sp = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
    if (sp) {
      f.capabilities = { tools: sp.indexOf("tools") >= 0,
        json: sp.indexOf("structured_outputs") >= 0 || sp.indexOf("response_format") >= 0,
        reasoning: sp.indexOf("reasoning") >= 0 || sp.indexOf("include_reasoning") >= 0 };
    }
    var cr = perMillion(m.pricing && m.pricing.input_cache_read);
    if (cr !== null && cr >= 0) f.cache_read_price_per_mtok = cr;
    var b = byId && byId[m.id + ":batch"];
    if (b && b.pricing) {
      var bi = perMillion(b.pricing.prompt), bo = perMillion(b.pricing.completion);
      if (bi !== null && bo !== null && bi >= 0 && bo >= 0) { f.batch_input_price_per_mtok = bi; f.batch_output_price_per_mtok = bo; }
    }
    var tp = m.top_provider || {};
    if (isNum(tp.max_completion_tokens) && tp.max_completion_tokens > 0) f.max_output_tokens = tp.max_completion_tokens;
    if (typeof m.expiration_date === "string" && parseDate(m.expiration_date) !== null) f.retires_on = m.expiration_date.slice(0, 10);
    if (isNum(m.created) && m.created > 0) f.listed_on = new Date(m.created * 1000).toISOString().slice(0, 10);
    return f;
  }

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
      var facts = liveFacts(live, byId);
      Object.keys(facts).forEach(function (k) { copy[k] = facts[k]; });
      copy.price_status = "live";
      copy.last_verified = stamp;
      copy.live = { fetchedAt: stamp, changes: diffs,
        before: { input: e.input_price_per_mtok, output: e.output_price_per_mtok, context: e.context_window, date: String(e.last_verified || "").slice(0, 10) } };
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
      var entry = {
        id: "live:" + id, model: String(m.name || id).split(": ").pop(), provider: provider, kind: "generation",
        openrouter_id: id, context_window: isNum(m.context_length) ? m.context_length : null,
        input_price_per_mtok: pin, output_price_per_mtok: pout, price_status: "live", unverified_fields: [],
        latency_class: null, quality_tier: null, task_fit: null,
        input_modalities: (arch.input_modalities || ["text"]).filter(function (x) { return ["text", "image", "file", "audio", "video"].indexOf(x) >= 0; }),
        open_weights: !!m.hugging_face_id, local_hardware: m.hugging_face_id ? "unknown" : null,
        strengths: ["Listed live on OpenRouter"], limits: ["Not reviewed by Model Scout: quality and speed are not rated"],
        source: { name: "OpenRouter live model list, fetched " + stamp, url: "https://openrouter.ai/" + id },
        last_verified: stamp, live: { fetchedAt: stamp, changes: [] }, liveOnly: true
      };
      var lf = liveFacts(m, byId);
      Object.keys(lf).forEach(function (k) { entry[k] = lf[k]; });
      liveOnly.push(entry);
    });
    return { models: merged, matched: matched, changed: changed, liveOnly: liveOnly };
  }

  // ---------- market watch ----------
  /** Percent change from a to b, or null when either is missing or a is zero. */
  function pctChange(a, b) { return isNum(a) && isNum(b) && a > 0 ? round((b - a) / a * 100, 1) : null; }

  /**
   * What changed on the market. entries: reviewed catalog entries (merged with live data when it loaded)
   * plus live-only entries. Returns:
   *   fresh: entries first listed on OpenRouter within the last `days` days (default 30), newest first;
   *   moves: reviewed entries whose live input or output price differs from the bundled snapshot, biggest change first;
   *   retiring: entries with a retirement date (past ones too, while still listed), soonest first.
   */
  function marketWatch(entries, now, opts) {
    opts = opts || {};
    var windowDays = isNum(opts.days) ? opts.days : NEW_WINDOW_DAYS;
    var nowMs = now instanceof Date ? now.getTime() : (isNum(now) ? now : Date.now());
    var fresh = [], moves = [], retiring = [];
    (entries || []).forEach(function (m) {
      if (!m) return;
      var listed = parseDate(m.listed_on);
      if (listed !== null) {
        var age = Math.floor((nowMs - listed) / DAY_MS);
        if (age >= 0 && age <= windowDays) fresh.push({ model: m, days: age, reviewed: !m.liveOnly });
      }
      var b = m.live && m.live.before;
      if (b && !m.liveOnly) {
        var ci = pctChange(b.input, m.input_price_per_mtok), co = pctChange(b.output, m.output_price_per_mtok);
        if ((isNum(b.input) && b.input !== m.input_price_per_mtok) || (isNum(b.output) && b.output !== m.output_price_per_mtok)) {
          moves.push({ model: m, since: b.date || null,
            input: { from: b.input, to: m.input_price_per_mtok, pct: ci },
            output: { from: b.output, to: m.output_price_per_mtok, pct: co } });
        }
      }
      var ret = retirement(m, nowMs);
      if (ret) retiring.push({ model: m, days: ret.days, past: ret.past, on: String(m.retires_on).slice(0, 10), reviewed: !m.liveOnly });
    });
    function name(a, b) { return String(a.model.model).localeCompare(String(b.model.model)); }
    function size(x) { return Math.max(Math.abs(x.input.pct || 0), Math.abs(x.output.pct || 0)); }
    fresh.sort(function (a, b) { return a.days - b.days || (b.reviewed - a.reviewed) || name(a, b); });
    moves.sort(function (a, b) { return size(b) - size(a) || name(a, b); });
    retiring.sort(function (a, b) { return a.days - b.days || (b.reviewed - a.reviewed) || name(a, b); });
    return { days: windowDays, fresh: fresh, moves: moves, retiring: retiring };
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
    if (s.taskType === "agentic" || has(/\b(function calling|tool calls?|call (our|an|the) api)\b/)) { s.tools = true; why.push("needs tool calling"); }
    if (has(/\b(json|structured output|schema|extract fields)\b/)) { s.json = true; why.push("mentions JSON or structured output"); }
    if (has(/\b(overnight|nightly|batch|backfill)\b/)) { s.useBatch = true; s.latency = "any"; why.push("mentions batch or overnight work"); }
    return { settings: s, why: why };
  }

  // ---------- profile settings: presets and shareable links ----------
  // Settings are what the form shows (volumes in millions, cache share as a fraction). profileFromSettings
  // turns them into the profile the engine scores against.
  var DEFAULT_SETTINGS = {
    taskType: "chat", modality: "text", quality: "good", latency: "balanced", contextNeed: 32000, budget: null,
    localOnly: false, inputM: 50, outputM: 10, cacheShare: 0, useBatch: false, tools: false, json: false, reasoning: false,
    weights: null
  };
  var SETTING_CHOICES = {
    taskType: ["chat", "code", "rag", "vision", "embeddings", "agentic"],
    modality: ["text", "image", "file", "audio", "video"],
    quality: ["basic", "good", "frontier"],
    latency: ["balanced", "fast", "any"],
    contextNeed: [8000, 32000, 128000, 200000, 400000, 1000000, 2000000],
    cacheShare: [0, 0.25, 0.5, 0.75, 0.9]
  };
  var BOOL_SETTINGS = ["localOnly", "useBatch", "tools", "json", "reasoning"];
  var URL_KEYS = {
    taskType: "task", modality: "input", quality: "quality", latency: "speed", contextNeed: "context", budget: "budget",
    localOnly: "local", inputM: "in", outputM: "out", cacheShare: "cache", useBatch: "batch", tools: "tools", json: "json", reasoning: "reasoning",
    weights: "w"
  };
  var PRESETS = [
    { id: "support", name: "Support bot", description: "Answer customer questions from our help center articles, quickly, at high volume",
      settings: { taskType: "rag", latency: "fast", budget: 1, inputM: 300, outputM: 30, cacheShare: 0.5 } },
    { id: "coding-agent", name: "Coding agent", description: "An agent that reads a repository, calls tools, runs the tests, and opens pull requests",
      settings: { taskType: "agentic", quality: "frontier", contextNeed: 200000, inputM: 200, outputM: 10, cacheShare: 0.75, tools: true } },
    { id: "bulk", name: "Bulk tagging", description: "Tag a million product reviews a month by topic and sentiment, returned as JSON, overnight",
      settings: { quality: "basic", latency: "any", contextNeed: 8000, budget: 0.5, inputM: 400, outputM: 20, useBatch: true, json: true } },
    { id: "contracts", name: "Contract review", description: "Read whole contracts and flag unusual clauses for a lawyer to check",
      settings: { taskType: "rag", quality: "frontier", latency: "any", contextNeed: 400000, inputM: 60, outputM: 3 } },
    { id: "private", name: "On our own servers", description: "Summarise confidential internal documents without the data leaving our machines",
      settings: { localOnly: true, inputM: 20, outputM: 4 } },
    { id: "screens", name: "Read scans", description: "Pull fields out of scanned invoices and screenshots as JSON",
      settings: { taskType: "vision", modality: "image", inputM: 40, outputM: 4, json: true } },
    { id: "search", name: "Semantic search", description: "Embed our document library so people can search it by meaning",
      settings: { taskType: "embeddings", contextNeed: 8000, inputM: 500, outputM: 0 } }
  ];

  function withDefaults(s) {
    var out = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = s && s[k] !== undefined ? s[k] : DEFAULT_SETTINGS[k]; });
    return out;
  }

  /** Full settings for a preset id, or null for an unknown id. */
  function presetSettings(id) {
    for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return withDefaults(PRESETS[i].settings);
    return null;
  }

  /** The engine's profile from form settings. */
  function profileFromSettings(s) {
    var f = withDefaults(s);
    function tok(m) { return isNum(m) && m > 0 ? m * 1e6 : 0; }
    return {
      taskType: f.taskType, modality: f.modality, quality: f.quality, latency: f.latency,
      contextNeed: isNum(f.contextNeed) ? f.contextNeed : 0, budget: isNum(f.budget) && f.budget > 0 ? f.budget : null,
      localOnly: !!f.localOnly, inputTokens: tok(f.inputM), outputTokens: tok(f.outputM),
      cacheShare: isNum(f.cacheShare) ? clamp(f.cacheShare, 0, MAX_CACHE_SHARE) : 0, useBatch: !!f.useBatch,
      needs: { tools: !!f.tools, json: !!f.json, reasoning: !!f.reasoning },
      weights: normalizeWeights(f.weights)
    };
  }

  /** Settings as a query string, so a ranking can be shared as a link. Defaults are left out. The task description is never included. */
  function encodeSettings(s) {
    var f = withDefaults(s), parts = [];
    Object.keys(URL_KEYS).forEach(function (k) {
      var v = f[k];
      if (v === DEFAULT_SETTINGS[k] || v === null || v === undefined) return;
      if (k === "cacheShare") v = Math.round(v * 100);
      if (k === "weights") {
        if (!normalizeWeights(v)) return;
        v = FACTORS.map(function (x) { return String(round(v[x], 1)); }).join("-");
      }
      if (v === true) v = 1;
      if (v === false) v = 0;
      parts.push(URL_KEYS[k] + "=" + encodeURIComponent(String(v)));
    });
    return parts.join("&");
  }

  function parseSetting(k, raw) {
    var x;
    if (k === "contextNeed") { x = Number(raw); return SETTING_CHOICES.contextNeed.indexOf(x) >= 0 ? x : undefined; }
    if (k === "cacheShare") { x = Number(raw) / 100; return SETTING_CHOICES.cacheShare.indexOf(x) >= 0 ? x : undefined; }
    if (SETTING_CHOICES[k]) return SETTING_CHOICES[k].indexOf(raw) >= 0 ? raw : undefined;
    if (BOOL_SETTINGS.indexOf(k) >= 0) return raw === "1" ? true : raw === "0" ? false : undefined;
    if (k === "weights") {
      var parts = String(raw).split("-");
      if (parts.length !== FACTORS.length || !parts.every(function (d) { return /^\d{1,3}(\.\d)?$/.test(d) && Number(d) <= 100; })) return undefined;
      var wv = {};
      FACTORS.forEach(function (f, i) { wv[f] = Number(parts[i]); });
      return normalizeWeights(wv) ? wv : undefined;
    }
    if (raw === "" || !/^\d*\.?\d+$/.test(raw)) return undefined;
    x = Number(raw);
    if (k === "budget") return x > 0 && x <= 1000 ? x : undefined;
    if (k === "inputM" || k === "outputM") return x >= 0 && x <= 1e6 ? x : undefined;
    return undefined;
  }

  /** Settings from a query string. Unknown keys and invalid values are skipped and listed in ignored. */
  function decodeSettings(qs) {
    var settings = {}, ignored = [], rev = {};
    Object.keys(URL_KEYS).forEach(function (k) { rev[URL_KEYS[k]] = k; });
    String(qs || "").replace(/^\?/, "").split("&").forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf("="), key, raw;
      try {
        key = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
        raw = i < 0 ? "" : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
      } catch (e) { ignored.push(pair); return; }
      var k = rev[key];
      if (!k) { ignored.push(key); return; }
      var v = parseSetting(k, raw);
      if (v === undefined) ignored.push(key); else settings[k] = v;
    });
    return { settings: settings, ignored: ignored };
  }

  // ---------- what if: one constraint changed at a time ----------
  var CONTEXT_STEPS = [8000, 32000, 128000, 200000, 400000, 1000000, 2000000];

  /** The single-constraint changes worth trying from these settings, as { id, label, settings }. */
  function leverOptions(s) {
    var f = withDefaults(s), out = [];
    function lever(id, label, change) {
      var n = {}; Object.keys(f).forEach(function (k) { n[k] = f[k]; });
      Object.keys(change).forEach(function (k) { n[k] = change[k]; });
      out.push({ id: id, label: label, settings: n });
    }
    if (!f.localOnly) {
      if (!f.useBatch && f.cacheShare < 0.5) lever("cache", "Half your input comes from the prompt cache", { cacheShare: 0.5 });
      if (!f.useBatch) lever("batch", "The work can wait for a batch run", { useBatch: true, latency: f.latency === "fast" ? "balanced" : f.latency });
    }
    if (f.quality === "frontier") lever("quality-down", "Accept a good quality bar instead of frontier", { quality: "good" });
    if (f.quality === "good") lever("quality-down", "Accept a basic quality bar", { quality: "basic" });
    if (f.quality === "basic") lever("quality-up", "Raise the quality bar to good", { quality: "good" });
    if (f.quality === "good") lever("quality-up", "Raise the quality bar to frontier", { quality: "frontier" });
    if (f.latency === "fast") lever("speed", "Relax the speed target to balanced", { latency: "balanced" });
    if (f.latency === "balanced" && !f.useBatch) lever("speed", "Speed does not matter", { latency: "any" });
    CAPABILITIES.forEach(function (k) {
      if (f[k]) { var c = {}; c[k] = false; lever("drop-" + k, "Drop the " + CAPABILITY_LABELS[k] + " requirement", c); }
    });
    if (isNum(f.budget) && f.budget > 0) lever("budget", "Remove the budget limit", { budget: null });
    if (f.localOnly) lever("hosted", "Allow hosted providers", { localOnly: false });
    else lever("local", "Keep the data on your own machines", { localOnly: true, useBatch: false, cacheShare: 0 });
    var ci = CONTEXT_STEPS.indexOf(f.contextNeed);
    if (ci > 1) lever("context", "Inputs up to " + fmtTokens(CONTEXT_STEPS[ci - 1]) + " tokens instead of " + fmtTokens(f.contextNeed), { contextNeed: CONTEXT_STEPS[ci - 1] });
    return out;
  }

  /**
   * What if one constraint changed? Re-rank for each lever and keep the ones that change the pick, or keep the
   * pick and cut its monthly cost by at least 5% (and a cent). Pick changes come first, then the biggest saving.
   * delta is null when either side is self-hosted (its cost is hardware, not tokens).
   * Returns { base: { top, cost }, levers: [{ id, label, settings, top, cost, pickChanged, delta, selfHosted, ranked }] }
   * or null when nothing is ranked under the current settings.
   */
  function whatIfs(models, settings, now) {
    var p0 = profileFromSettings(settings), r0 = rankModels(models, p0, now), top0 = r0.ranked[0];
    if (!top0) return null;
    var cost0 = monthlyCost(top0.model, p0.inputTokens, p0.outputTokens, p0);
    var levers = [];
    leverOptions(settings).forEach(function (lv) {
      var p = profileFromSettings(lv.settings), r = rankModels(models, p, now), top = r.ranked[0];
      if (!top) { levers.push({ id: lv.id, label: lv.label, settings: lv.settings, top: null, cost: null, pickChanged: true, delta: null, ranked: 0 }); return; }
      // Self-hosted costs are hardware, not tokens, so no saving is quoted when either side runs locally.
      var selfHosted = p.localOnly || p0.localOnly;
      var cost = p.localOnly ? null : monthlyCost(top.model, p.inputTokens, p.outputTokens, p);
      var delta = !selfHosted && isNum(cost) && isNum(cost0) ? cost - cost0 : null;
      var changed = top.model.id !== top0.model.id;
      var saves = delta !== null && -delta >= 0.01 && (cost0 > 0 ? -delta / cost0 >= 0.05 : true);
      if (!changed && !saves) return;
      levers.push({ id: lv.id, label: lv.label, settings: lv.settings, top: top.model, cost: cost, pickChanged: changed, delta: delta,
        selfHosted: !!p.localOnly, ranked: r.ranked.length });
    });
    levers.sort(function (a, b) {
      if (a.pickChanged !== b.pickChanged) return a.pickChanged ? -1 : 1;
      return (a.delta === null ? Infinity : a.delta) - (b.delta === null ? Infinity : b.delta);
    });
    return { base: { top: top0.model, cost: cost0 }, levers: levers };
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

  // ---------- chat: OpenRouter (your key) or local Ollama (no key) ----------
  // Pure helpers: they build requests and read answers, and take fetch and storage as
  // arguments, so node tests can drive them with stubs. No key is ever stored in code.
  var OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
  var OLLAMA_CHAT_URL = "http://localhost:11434/api/chat";
  var LOCAL_MODEL = "dolphin3";
  var LOCAL_LABEL = "dolphin3 (local Ollama)";
  var DEFAULT_CHAT_MODEL = "cognitivecomputations/dolphin-mistral-24b-venice-edition";
  var FEATURED_CHAT_MODELS = [
    { id: DEFAULT_CHAT_MODEL, name: "Venice Uncensored" },
    { id: "nousresearch/hermes-3-llama-3.1-70b", name: "Nous Hermes 3 70B" }
  ];
  var KEY_STORAGE = "model-scout.openrouter-key";
  var CHAT_TIMEOUT_MS = 120000; // no answer (or no new streamed text) for this long stops the request
  var SIDE_STATUS = {
    idle: { cls: "idle", text: "Ready" }, sending: { cls: "live", text: "Sending" },
    done: { cls: "ok", text: "Done" }, error: { cls: "warn", text: "Error" }
  };

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /** Request for one chat call. OpenRouter needs a key (sent as a Bearer header); local Ollama always uses dolphin3 and no key. */
  function buildChatRequest(provider, model, messages, key, stream) {
    var msgs = (messages || []).map(function (m) { return { role: m.role, content: String(m.content) }; });
    if (provider === "local") {
      return {
        ok: true, provider: "local", model: LOCAL_MODEL, stream: !!stream, url: OLLAMA_CHAT_URL,
        init: { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: LOCAL_MODEL, messages: msgs, stream: !!stream }) }
      };
    }
    var k = String(key || "").trim();
    if (!k) return { ok: false, code: "no-key", error: "No OpenRouter key saved. Paste your key in the key box and press Save key." };
    if (!model) return { ok: false, code: "no-model", error: "Choose a model first." };
    var body = { model: model, messages: msgs };
    if (stream) body.stream = true;
    return {
      ok: true, provider: "openrouter", model: model, stream: !!stream, url: OPENROUTER_CHAT_URL,
      init: { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + k }, body: JSON.stringify(body) }
    };
  }

  /** The error message inside an OpenRouter ({ error: { message } }) or Ollama ({ error: "..." }) body. */
  function chatErrorDetail(j) {
    if (!j || !j.error) return "";
    var e = j.error, msg = typeof e === "string" ? e : (e.message || "");
    return String(msg).slice(0, 300);
  }

  /** The answer text in a non-streamed response, or null when the shape is not recognised. */
  function chatText(provider, j) {
    if (!j || typeof j !== "object") return null;
    if (provider === "local") return j.message && typeof j.message.content === "string" ? j.message.content : null;
    var c = j.choices && j.choices[0];
    return c && c.message && typeof c.message.content === "string" ? c.message.content : null;
  }

  function httpErrorText(provider, status, detail) {
    var who = provider === "local" ? "Ollama" : "OpenRouter";
    var said = detail ? " " + who + " said: " + detail : "";
    if (provider !== "local") {
      if (status === 401) return "OpenRouter rejected the key (HTTP 401). Check or replace the key in the key box." + said;
      if (status === 402) return "Your OpenRouter account does not have enough credits for this model (HTTP 402)." + said;
      if (status === 403) return "OpenRouter refused this request (HTTP 403), for example a moderation block." + said;
      if (status === 404) return "OpenRouter does not serve this model right now (HTTP 404). Pick another model." + said;
      if (status === 429) return "OpenRouter is rate limiting this key or model (HTTP 429). Wait a moment and try again." + said;
    } else if (status === 404) {
      return "Ollama does not have the dolphin3 model (HTTP 404). Run: ollama pull dolphin3." + said;
    }
    return who + " returned HTTP " + status + "." + said;
  }

  /** Can this page reach Ollama? Only when served over plain http from this computer. */
  function localModeCheck(href) {
    var u;
    try { u = new URL(String(href)); } catch (e) { return { ok: false, text: "Could not tell where this page is served from." }; }
    var host = u.hostname.replace(/^\[|\]$/g, "");
    var isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || /\.localhost$/.test(host);
    if (u.protocol === "http:" && isLocal) return { ok: true, text: "This page is served from " + u.host + ", so it can reach Ollama on this computer." };
    if (u.protocol === "file:") return { ok: false, text: "This page is open as a file. Serve the folder from localhost (python3 -m http.server 8000) so it can reach Ollama." };
    return { ok: false, text: "This page is served from " + u.host + " over " + u.protocol.replace(":", "") + ", so the browser will block calls to Ollama. Serve Model Scout from localhost to use local mode." };
  }

  function networkErrorText(provider, err, pageUrl, timeoutMs) {
    if (err && err.name === "AbortError") return "No answer for " + Math.round(timeoutMs / 1000) + " seconds, so the request was stopped. Try again or pick a faster model.";
    var why = err && err.message ? err.message : "unknown error";
    if (provider === "local") {
      var where = localModeCheck(pageUrl);
      return "Could not reach Ollama on localhost port 11434 (" + why + "). Check that Ollama is running and has dolphin3." + (where.ok ? "" : " " + where.text);
    }
    return "Could not reach OpenRouter (" + why + "). Check your connection, or whether an extension blocks openrouter.ai.";
  }

  /** Split a growing stream buffer into whole lines plus the unfinished tail. */
  function takeLines(buf) {
    var parts = String(buf).split(/\r?\n/);
    return { lines: parts.slice(0, -1), rest: parts[parts.length - 1] };
  }

  /** One streamed line: OpenRouter sends server-sent events ("data: {...}", ": comment", "data: [DONE]"), Ollama sends JSON lines. */
  function streamDelta(provider, line) {
    var s = String(line || "").trim();
    if (!s) return {};
    if (provider !== "local") {
      if (s.indexOf("data:") !== 0) return {}; // comments such as ": OPENROUTER PROCESSING", and event or id lines
      s = s.slice(5).trim();
      if (s === "[DONE]") return { done: true };
    }
    var j;
    try { j = JSON.parse(s); } catch (e) { return {}; }
    if (j && j.error) return { error: chatErrorDetail(j) || "The stream reported an error." };
    if (provider === "local") return { text: (j.message && typeof j.message.content === "string") ? j.message.content : "", done: !!j.done };
    var c = j.choices && j.choices[0];
    return { text: c && c.delta && typeof c.delta.content === "string" ? c.delta.content : "" };
  }

  /**
   * Send one chat request. Never rejects: resolves { ok, text, error, status }.
   * opts.onDelta(textSoFar) runs as streamed text arrives. A partial streamed answer is kept on error.
   */
  function sendChat(fetchFn, req, opts) {
    opts = opts || {};
    if (!req || !req.ok) return Promise.resolve({ ok: false, text: "", error: (req && req.error) || "Nothing to send." });
    if (typeof fetchFn !== "function") return Promise.resolve({ ok: false, text: "", error: "This browser cannot send requests (no fetch)." });
    var timeoutMs = opts.timeoutMs || CHAT_TIMEOUT_MS;
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = null;
    function arm() { clearTimeout(timer); timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs); }
    var init = {};
    Object.keys(req.init).forEach(function (k) { init[k] = req.init[k]; });
    if (ctrl) init.signal = ctrl.signal;
    var acc = { text: "" };
    function delta(d) {
      if (d.text) { acc.text += d.text; if (opts.onDelta) opts.onDelta(acc.text); }
    }
    arm();
    var p;
    try { p = Promise.resolve(fetchFn(req.url, init)); } catch (e) { p = Promise.reject(e); }
    return p.then(function (res) {
      if (!res.ok) {
        var body = typeof res.json === "function" ? res.json().catch(function () { return null; }) : Promise.resolve(null);
        return body.then(function (j) { return { ok: false, status: res.status, text: "", error: httpErrorText(req.provider, res.status, chatErrorDetail(j)) }; });
      }
      if (req.stream) return readStream(res, req, delta, arm, acc);
      return res.json().then(function (j) {
        var detail = chatErrorDetail(j);
        if (detail) return { ok: false, status: res.status, text: "", error: (req.provider === "local" ? "Ollama" : "OpenRouter") + " reported an error: " + detail };
        var t = chatText(req.provider, j);
        if (t === null) return { ok: false, status: res.status, text: "", error: "The response did not contain an answer Model Scout can read." };
        if (!t.trim()) return { ok: false, status: res.status, text: "", error: "The model returned an empty answer." };
        return { ok: true, status: res.status, text: t, error: "" };
      }, function () {
        return { ok: false, status: res.status, text: "", error: "The response was not valid JSON." };
      });
    }).catch(function (e) {
      return { ok: false, text: acc.text, error: networkErrorText(req.provider, e, opts.pageUrl, timeoutMs) };
    }).then(function (r) { clearTimeout(timer); return r; });
  }

  /** Read a streamed body chunk by chunk. Falls back to reading it whole when the browser has no stream reader. */
  function readStream(res, req, delta, arm, acc) {
    var failed = "";
    function handle(lines) {
      for (var i = 0; i < lines.length && !failed; i++) {
        var d = streamDelta(req.provider, lines[i]);
        if (d.error) failed = d.error;
        else delta(d);
      }
    }
    function finish() {
      if (failed) return { ok: false, status: res.status, text: acc.text, error: "The model stopped with an error: " + failed };
      if (!acc.text.trim()) return { ok: false, status: res.status, text: "", error: "The model returned an empty answer." };
      return { ok: true, status: res.status, text: acc.text, error: "" };
    }
    var reader = res.body && typeof res.body.getReader === "function" && typeof TextDecoder === "function" ? res.body.getReader() : null;
    if (!reader) {
      return res.text().then(function (all) { handle(String(all).split(/\r?\n/)); return finish(); });
    }
    var dec = new TextDecoder(), buf = "";
    function pump() {
      return reader.read().then(function (r) {
        arm(); // each chunk restarts the idle timer
        if (r.done) { buf += dec.decode(); handle([buf]); return finish(); }
        var split = takeLines(buf + dec.decode(r.value, { stream: true }));
        buf = split.rest;
        handle(split.lines);
        if (failed) { try { reader.cancel(); } catch (e) { /* already closed */ } return finish(); }
        return pump();
      });
    }
    return pump();
  }

  /**
   * Side by side: fire every column at once. Each column settles on its own, so a failure (or a render
   * problem) in one never blocks the other. cols: [{ model, label, req }]. onUpdate(index, column) runs
   * on every status change. Resolves with the final columns.
   */
  function runCompare(fetchFn, cols, onUpdate, opts) {
    opts = opts || {};
    return Promise.all(cols.map(function (col, i) {
      var st = { model: col.model || "", label: col.label || "", status: "sending", text: "", error: "" };
      function update() { try { if (onUpdate) onUpdate(i, st); } catch (e) { /* keep the other column going */ } }
      if (!col.req || !col.req.ok) {
        st.status = "error";
        st.error = (col.req && col.req.error) || "No model chosen for this column.";
        update();
        return Promise.resolve(st);
      }
      update();
      return sendChat(fetchFn, col.req, { pageUrl: opts.pageUrl, timeoutMs: opts.timeoutMs, onDelta: function (t) { st.text = t; update(); } })
        .then(function (r) {
          st.status = r.ok ? "done" : "error";
          st.text = r.text || st.text;
          st.error = r.ok ? "" : r.error;
          update();
          return st;
        }, function (e) {
          st.status = "error";
          st.error = "Unexpected error: " + (e && e.message ? e.message : "unknown");
          update();
          return st;
        });
    }));
  }

  /** One side-by-side column: which side, the model name, its status, then the answer or the error. */
  function sideColumnHtml(side, col) {
    col = col || {};
    var st = SIDE_STATUS[col.status] || SIDE_STATUS.idle;
    var body;
    if (col.status === "error") {
      body = (col.text ? '<div class="msg-text">' + escapeHtml(col.text) + "</div>" : "") + '<p class="verdict warn">' + escapeHtml(col.error) + "</p>";
    } else if (col.text) {
      body = '<div class="msg-text">' + escapeHtml(col.text) + "</div>";
    } else if (col.status === "sending") {
      body = '<p class="loading-line"><span class="spinner" aria-hidden="true"></span>Waiting for ' + escapeHtml(col.label || "the model") + "...</p>";
    } else {
      body = '<p class="muted">The answer appears here.</p>';
    }
    return '<header class="side-head"><p class="eyebrow">' + escapeHtml(side) + "</p>" +
      '<h3 class="side-name">' + escapeHtml(col.label || "No model chosen") + "</h3>" +
      '<span class="badge ' + st.cls + '">' + st.text + "</span>" +
      (col.model ? '<p class="side-id">' + escapeHtml(col.model) + "</p>" : "") + "</header>" +
      '<div class="side-body">' + body + "</div>";
  }

  /** Where "Ask this model" goes: the chat model in single mode; in side by side, the first empty slot, else the left one. */
  function askTarget(mode, slots) {
    if (mode !== "side") return { target: "single" };
    var s = slots || [];
    return { target: "slot", index: !s[0] ? 0 : (!s[1] ? 1 : 0) };
  }

  // The key lives in the browser's localStorage only. These take the storage object so tests can stub it.
  function readKey(storage) {
    try { return (storage && storage.getItem(KEY_STORAGE)) || ""; } catch (e) { return ""; }
  }
  function saveKey(storage, key) {
    var k = String(key || "").trim();
    if (!k) return { ok: false, error: "Paste a key first." };
    if (/\s/.test(k)) return { ok: false, error: "That key contains spaces. Copy it again from openrouter.ai/keys." };
    try { storage.setItem(KEY_STORAGE, k); return { ok: true }; } catch (e) {
      return { ok: false, error: "This browser blocks local storage, so the key cannot be saved here. Allow site data for this page, or use Local Ollama." };
    }
  }
  function forgetKey(storage) {
    try { storage.removeItem(KEY_STORAGE); return true; } catch (e) { return false; }
  }

  var api = {
    STALE_AFTER_DAYS: STALE_AFTER_DAYS, REQUIRED_FIELDS: REQUIRED_FIELDS, SWITCH_MARGIN: SWITCH_MARGIN,
    monthlyCost: monthlyCost, blendedPrice: blendedPrice, staleStatus: staleStatus, validateEntry: validateEntry,
    dataFlags: dataFlags, computeWeights: computeWeights, scoreModel: scoreModel, rankModels: rankModels,
    switchCheck: switchCheck, mergeLive: mergeLive, suggestFromText: suggestFromText, costScoreFromPrice: costScoreFromPrice,
    fmtMoney: fmtMoney, fmtTokens: fmtTokens,
    CAPABILITIES: CAPABILITIES, DEFAULT_SETTINGS: DEFAULT_SETTINGS, PRESETS: PRESETS,
    effectivePrices: effectivePrices, volumeFromRequests: volumeFromRequests, estimateTokens: estimateTokens, sampleEstimate: sampleEstimate, CACHE_MIN_TOKENS: CACHE_MIN_TOKENS, retirement: retirement, liveFacts: liveFacts, perMillion: perMillion,
    robustness: robustness, presetSettings: presetSettings, profileFromSettings: profileFromSettings,
    encodeSettings: encodeSettings, decodeSettings: decodeSettings,
    frontier: frontier, cheaperAlternative: cheaperAlternative, valueMapSvg: valueMapSvg, headToHead: headToHead, decisionMemo: decisionMemo,
    FACTORS: FACTORS, normalizeWeights: normalizeWeights, weightsAt: weightsAt, sharesToPercents: sharesToPercents,
    tippingPoints: tippingPoints, tipWeights: tipWeights, tipSentence: tipSentence, shareLabel: shareLabel,
    marketWatch: marketWatch, pctChange: pctChange, leverOptions: leverOptions, whatIfs: whatIfs,
    OPENROUTER_CHAT_URL: OPENROUTER_CHAT_URL, OLLAMA_CHAT_URL: OLLAMA_CHAT_URL, LOCAL_MODEL: LOCAL_MODEL,
    DEFAULT_CHAT_MODEL: DEFAULT_CHAT_MODEL, FEATURED_CHAT_MODELS: FEATURED_CHAT_MODELS, KEY_STORAGE: KEY_STORAGE,
    buildChatRequest: buildChatRequest, chatText: chatText, httpErrorText: httpErrorText, localModeCheck: localModeCheck,
    takeLines: takeLines, streamDelta: streamDelta, sendChat: sendChat, runCompare: runCompare,
    sideColumnHtml: sideColumnHtml, askTarget: askTarget, readKey: readKey, saveKey: saveKey, forgetKey: forgetKey
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  // =====================================================================
  // Browser UI
  // =====================================================================
  var CARD_LIMIT = 6;
  var state = { catalog: null, catalogOrigin: "", base: [], liveOnly: [], live: null, liveIds: null, now: new Date(), lastOrder: null,
    touched: false, showAllCards: false, linkNote: "", compare: [], lastRes: null, lastProfile: null,
    customWeights: null, editWeights: false, mwOpen: { fresh: false, retire: false } };
  var COMPARE_MAX = 3;
  var TIP_ROWS = 4;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function safeUrl(u) { return /^https:\/\//.test(String(u || "")) ? u : "#"; }

  var CHECK_IDS = { localOnly: "local-only", useBatch: "use-batch", tools: "need-tools", json: "need-json", reasoning: "need-reasoning" };
  var SELECT_IDS = { taskType: "task-type", modality: "modality", quality: "quality", latency: "latency", contextNeed: "context-need", cacheShare: "cache-share" };

  /** What the form shows, as settings (volumes in millions). */
  function readSettings() {
    var budgetRaw = $("budget").value.trim();
    var budget = budgetRaw === "" ? null : parseFloat(budgetRaw);
    function num(id) { var v = parseFloat($(id).value); return isFinite(v) && v > 0 ? v : 0; }
    var s = {
      taskType: $("task-type").value, modality: $("modality").value, quality: $("quality").value, latency: $("latency").value,
      contextNeed: parseInt($("context-need").value, 10) || 0, budget: isFinite(budget) && budget > 0 ? budget : null,
      inputM: num("vol-in"), outputM: num("vol-out"), cacheShare: parseFloat($("cache-share").value) || 0
    };
    Object.keys(CHECK_IDS).forEach(function (k) { s[k] = $(CHECK_IDS[k]).checked; });
    s.weights = state.customWeights ? copyWeights(state.customWeights) : null;
    return s;
  }

  function copyWeights(w) { var o = {}; FACTORS.forEach(function (k) { o[k] = w[k]; }); return o; }

  /** Put settings into the form. Only the keys present change. */
  function applySettings(s) {
    Object.keys(SELECT_IDS).forEach(function (k) { if (k in s) $(SELECT_IDS[k]).value = String(s[k]); });
    Object.keys(CHECK_IDS).forEach(function (k) { if (k in s) $(CHECK_IDS[k]).checked = !!s[k]; });
    if ("budget" in s) $("budget").value = s.budget == null ? "" : String(s.budget);
    if ("inputM" in s) $("vol-in").value = String(s.inputM);
    if ("outputM" in s) $("vol-out").value = String(s.outputM);
    if ("weights" in s) {
      state.customWeights = normalizeWeights(s.weights) ? copyWeights(s.weights) : null;
      if (!state.customWeights) state.editWeights = false;
    }
  }

  function readProfile() {
    var p = profileFromSettings(readSettings());
    p.description = $("task-desc").value;
    return p;
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

  var WEIGHTS_NOTE = "Weights shift with your constraints: a tight budget raises cost, a long input raises context fit, local-only raises privacy.";
  var CUSTOM_NOTE = "Set by hand, so your constraints no longer move these weights. Hard limits (input type, local only, required capabilities) still apply. Each slider sets relative importance; the shares add up to 100%.";

  /** The weights box: bars for profile weights, sliders while setting them by hand. Sliders update in place so one being dragged keeps focus. */
  function renderWeights(w) {
    var list = $("weights"), custom = !!state.customWeights, editing = custom && state.editWeights;
    if (editing && list.getAttribute("data-mode") === "edit") {
      FACTORS.forEach(function (k) {
        var input = $("w-" + k);
        if (!input) return;
        input.setAttribute("aria-valuetext", pct(w[k]) + "% of the weight");
        if (document.activeElement !== input) input.value = String(Math.round(state.customWeights[k]));
        input.parentNode.querySelector(".wval").textContent = pct(w[k]) + "%";
      });
    } else {
      list.innerHTML = FACTORS.map(function (k) {
        var name = COMPONENT_LABELS[k];
        if (editing) {
          return '<li class="is-edit"><label class="wname" for="w-' + k + '">' + name + "</label>" +
            '<input type="range" id="w-' + k + '" data-factor="' + k + '" min="0" max="100" step="1" value="' + Math.round(state.customWeights[k]) +
            '" aria-valuetext="' + pct(w[k]) + '% of the weight"><span class="wval">' + pct(w[k]) + "%</span></li>";
        }
        return '<li><span class="wname">' + name + "</span>" + bar(w[k] / 0.5 > 1 ? 1 : w[k] / 0.5) + '<span class="wval">' + pct(w[k]) + "%</span></li>";
      }).join("");
      list.setAttribute("data-mode", editing ? "edit" : "view");
    }
    $("weights-edit").setAttribute("aria-pressed", String(editing));
    $("weights-reset").hidden = !custom;
    $("weights-h").textContent = custom ? "Your weights, set by hand" : "How your profile weights each factor";
    $("weights-note").textContent = custom ? CUSTOM_NOTE : WEIGHTS_NOTE;
  }

  /** "What would change the pick": the nearest tipping points, each with a button that tries it. */
  function renderTips(res) {
    var tp = tippingPoints(res), list = $("tips");
    state.lastTips = tp;
    if (!tp) { list.innerHTML = '<li class="tip-none">No pick to test: every model failed a hard constraint.</li>'; return; }
    if (tp.near || tp.single) { list.innerHTML = '<li class="tip-none">' + esc(tipSentence(tp)) + "</li>"; return; }
    var rows = [];
    tp.factors.forEach(function (f) {
      ["up", "down"].forEach(function (dir) { if (f[dir]) rows.push({ f: f, dir: dir, tip: f[dir], dist: Math.abs(f[dir].share - f.share) }); });
    });
    rows.sort(function (a, b) { return a.dist - b.dist; });
    var fixed = tp.factors.filter(function (f) { return !f.up && !f.down; }).map(function (f) { return COMPONENT_LABELS[f.key]; });
    var html = rows.slice(0, TIP_ROWS).map(function (r, i) {
      var label = COMPONENT_LABELS[r.f.key];
      return '<li class="tip' + (i === 0 ? " is-nearest" : "") + '">' +
        '<p class="tip-move"><span class="tip-factor">' + esc(label.charAt(0).toUpperCase() + label.slice(1)) + "</span> " +
          (r.dir === "up" ? "rises" : "falls") + " from " + shareLabel(r.f.share, r.tip.share) + " to <strong>" + shareLabel(r.tip.share, r.f.share) + "</strong></p>" +
        '<p class="tip-who"><a href="#card-' + esc(r.tip.model.id) + '">' + esc(r.tip.model.model) + "</a> comes first</p>" +
        '<button type="button" class="btn btn-small tip-try" data-tip-key="' + r.f.key + '" data-tip-dir="' + r.dir + '" aria-label="Try it: set ' +
          esc(label) + " to " + shareLabel(r.tip.share, r.f.share) + ", where " + esc(r.tip.model.model) + ' comes first">Try it</button></li>';
    }).join("");
    if (!rows.length) html = '<li class="tip-none">' + esc(tipSentence(tp)) + "</li>";
    if (fixed.length && rows.length) {
      html += '<li class="tip-none">' + esc(listWords(fixed).charAt(0).toUpperCase() + listWords(fixed).slice(1)) + ": no share from 0% to 100% changes the pick.</li>";
    }
    list.innerHTML = html;
  }

  function listWords(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }

  function tryTip(key, dir) {
    var p = readProfile(), out = tipWeights(candidates(), p, state.now, key, dir), status = $("tips-status");
    if (!out) { status.textContent = "Could not find weights past that point. Set them by hand instead."; return; }
    state.customWeights = copyWeights(out.weights);
    state.editWeights = true;
    state.touched = true;
    markPreset("");
    render();
    status.textContent = "Weights set by hand: " + out.model.model + " now comes first. Back to profile weights undoes it.";
    $("weights-reset").focus();
  }

  function toggleWeightEdit() {
    if (state.customWeights && state.editWeights) state.editWeights = false;
    else {
      if (!state.customWeights && state.lastRes) {
        var w = state.lastRes.weights;
        state.customWeights = {};
        FACTORS.forEach(function (k) { state.customWeights[k] = round(w[k] * 100, 1); });
      }
      state.editWeights = !!state.customWeights;
    }
    state.touched = true;
    render();
    var first = state.editWeights ? $("weights").querySelector("input") : null;
    if (first) first.focus();
  }

  function resetWeights() {
    state.customWeights = null;
    state.editWeights = false;
    $("tips-status").textContent = "Back to the weights your profile sets.";
    render();
    $("weights-edit").focus();
  }

  function costCell(r, p) {
    var mc = monthlyCost(r.model, p.inputTokens, p.outputTokens, p);
    if (p.localOnly) return "Self-hosted<br><small>hosted reference " + esc(fmtMoney(mc)) + "</small>";
    return esc(fmtMoney(mc));
  }

  /** Which discounts the monthly figure includes, as a short note. */
  function costBasis(m, p) {
    var e = effectivePrices(m, p), bits = [];
    if (!e) return "";
    if (e.batch) bits.push("at batch prices");
    if (e.cache) bits.push("with " + Math.round(p.cacheShare * 100) + "% of input cached");
    return bits.length ? ", " + bits.join(", ") : "";
  }

  /** Large monthly cost readout for the top pick and the model cards. */
  function costFigure(r, p) {
    var mc = monthlyCost(r.model, p.inputTokens, p.outputTokens, p);
    if (p.localOnly) {
      return '<span class="figure-value cost">Self-hosted<span class="unit">hosted reference ' + esc(fmtMoney(mc)) + " per month</span></span>";
    }
    return '<span class="figure-value cost">' + esc(fmtMoney(mc)) + '<span class="unit">per month at your volume' + esc(costBasis(r.model, p)) + "</span></span>";
  }

  /** Capabilities and limits from OpenRouter's list, as one sentence for a card. */
  function capsText(m) {
    if (m.kind === "embedding") return "";
    if (!m.capabilities) return "Capabilities: no data (not listed on OpenRouter).";
    var yes = CAPABILITIES.filter(function (k) { return m.capabilities[k]; }).map(function (k) { return CAPABILITY_LABELS[k]; });
    var no = CAPABILITIES.filter(function (k) { return !m.capabilities[k]; }).map(function (k) { return CAPABILITY_LABELS[k]; });
    var t = yes.length ? "Supports " + yes.join(", ") + "." : "Lists none of tool calling, JSON output, or reasoning mode.";
    if (yes.length && no.length) t += " Not listed: " + no.join(", ") + ".";
    if (isNum(m.max_output_tokens)) t += " Longest answer: " + fmtTokens(m.max_output_tokens) + " tokens.";
    return t;
  }

  /** Cache and batch prices, when listed. */
  function extraPricesText(m) {
    var bits = [];
    if (isNum(m.cache_read_price_per_mtok)) bits.push("cache read " + fmtPrice(m.cache_read_price_per_mtok) + " per 1M");
    if (isNum(m.batch_input_price_per_mtok)) bits.push("batch " + fmtPrice(m.batch_input_price_per_mtok) + " in / " + fmtPrice(m.batch_output_price_per_mtok) + " out per 1M");
    return bits.length ? "Other listed prices: " + bits.join("; ") + "." : "";
  }

  var CONFIDENCE_LABEL = { stable: "Stable pick", likely: "Likely pick", close: "Close call", tie: "Tie" };

  /** A share of reruns as a percentage that never rounds a rare win down to 0% or a near sweep up to 100%. */
  function fmtShare(x) {
    if (x >= 1) return "100%";
    if (x > 0.995) return "over 99%";
    if (x > 0 && x < 0.005) return "under 1%";
    return pct(x) + "%";
  }

  /** The robustness check under the top pick: a verdict, one sentence, and a bar of who wins how often. */
  function confidenceHtml(rb, top) {
    if (!rb) return "";
    var ru = rb.runnerUp, n = rb.samples, text;
    var rivals = rb.shares.filter(function (s) { return s.model.id !== top.model.id; });
    if (rb.verdict === "tie") {
      text = "Ties " + ru.model.model + " on every factor, so no weighting separates them. It is listed first only because it costs less per month, or sorts first by name.";
    } else {
      text = "Stays first in " + fmtShare(rb.topShare) + " of " + n + " reruns, with each factor's weight scaled at random between half and double.";
      if (rivals.length) text += " Most frequent rival: " + rivals[0].model.model + " (" + fmtShare(rivals[0].share) + ").";
      else text += " No rival comes first in any rerun.";
      if (ru && ru.dominated) text += " It matches or beats " + ru.model.model + " on every factor.";
    }
    var segs = rb.shares.slice(0, 5).map(function (s) {
      var me = s.model.id === top.model.id;
      return '<span class="conf-seg' + (me ? " is-top" : "") + '" style="flex-grow:' + Math.max(s.share, 0.01).toFixed(3) + '" title="' + esc(s.model.model + ": " + fmtShare(s.share)) + '"></span>';
    }).join("");
    var legend = rb.shares.slice(0, 3).map(function (s) {
      return "<li" + (s.model.id === top.model.id ? ' class="is-top"' : "") + "><span>" + esc(s.model.model) + "</span><span>" + fmtShare(s.share) + "</span></li>";
    }).join("");
    return '<div class="confidence" data-verdict="' + rb.verdict + '">' +
      '<p class="conf-head"><span class="figure-label">Confidence</span><span class="conf-verdict">' + CONFIDENCE_LABEL[rb.verdict] + "</span></p>" +
      (rb.verdict === "tie" ? "" : '<div class="conf-bar" aria-hidden="true">' + segs + "</div>" +
        '<ul class="conf-legend" aria-label="Share of reruns each model wins">' + legend + "</ul>") +
      '<p class="conf-text">' + esc(text) + "</p></div>";
  }

  var BEST_FLAG = '<span class="best-flag"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 1.5l1.9 4.1 4.5.5-3.4 3 1 4.4L8 11.3 4 13.5l1-4.4-3.4-3 4.5-.5z"/></svg>Best pick</span>';
  var COLUMNS = ["Rank", "Model", "Score", "Cost", "Quality", "Speed", "Context fit", "Privacy", "Monthly cost", "Price in / out per 1M", "Context", "Data"];

  function flagList(items) {
    return items.length ? '<ul class="flags">' + items.join("") + "</ul>" : "";
  }

  /** Inline errors next to the number fields. Values are still read the same way by readProfile. */
  function validateFields() {
    [["budget", "Enter a price of 0 or more, or leave it empty for no limit. Until then there is no budget limit."],
     ["vol-in", "Enter 0 or more million tokens. Until then input volume counts as 0."],
     ["vol-out", "Enter 0 or more million tokens. Until then output volume counts as 0."]].forEach(function (f) {
      var el = $(f[0]), msg = $(f[0] + "-error");
      if (!el || !msg) return;
      var raw = el.value.trim();
      var bad = (el.validity && el.validity.badInput) || (raw !== "" && (!isFinite(parseFloat(raw)) || parseFloat(raw) < 0));
      if (bad) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid");
      if (msg.textContent !== (bad ? f[1] : "")) msg.textContent = bad ? f[1] : "";
    });
  }

  function render() {
    if (!state.base.length) return;
    validateFields();
    var p = readProfile();
    var res = rankModels(candidates(), p, state.now);
    renderWeights(res.weights);
    renderTips(res);
    state.lastRes = res;
    state.lastProfile = p;
    var top = res.ranked[0];

    // The reveal animation plays only when the ranking order changes, not on every keystroke.
    var order = res.ranked.map(function (r) { return r.model.id; }).join("|");
    var reveal = order !== state.lastOrder;
    state.lastOrder = order;

    // headline
    var head = $("top-pick");
    head.setAttribute("aria-busy", "false");
    head.classList.toggle("is-reveal", reveal);
    head.classList.toggle("is-empty", !top);
    if (!top) {
      head.innerHTML = '<p class="eyebrow">No result for this profile</p>' +
        '<h3>No model fits every hard constraint</h3><p>Every candidate was excluded. See the excluded list below and loosen a constraint (for example turn off local-only or change the modality).</p>';
    } else {
      var tf = dataFlags(top.model, state.now);
      head.innerHTML = BEST_FLAG +
        '<p class="eyebrow">Top pick for this profile</p>' +
        "<h3>" + esc(top.model.model) + ' <span class="provider">' + esc(top.model.provider) + "</span></h3>" +
        '<div class="figures">' +
          '<p class="score-big"><span class="figure-label">Score</span><span class="figure-value score">' + top.total + " <small>of 100</small></span></p>" +
          '<p><span class="figure-label">Estimated monthly cost</span>' + costFigure(top, p) + "</p>" +
        "</div>" +
        '<p class="reason"><strong>Why:</strong> ' + esc(top.explain.why) + "</p>" +
        '<p class="reason"><strong>What you trade away:</strong> ' + esc(top.explain.tradeoffs) + "</p>" +
        altHtml(cheaperAlternative(res.ranked, p)) +
        confidenceHtml(robustness(res), top) +
        flagList(tf.map(function (f) { return '<li class="' + f.level + '">' + esc(f.text) + "</li>"; })) +
        flagList(top.flags.map(function (f) { return '<li class="warn">' + esc(f) + "</li>"; }));
    }

    // table: every cell carries its column name so narrow screens can stack rows as labelled cards
    function td(i, cls, html) { return '<td class="' + cls + '" data-label="' + esc(COLUMNS[i]) + '">' + html + "</td>"; }
    var rows = res.ranked.map(function (r) {
      var c = r.components, m = r.model;
      return '<tr class="' + (r.rank === 1 ? "is-top" : "") + '">' +
        td(0, "rank-cell", "#" + r.rank) +
        '<th scope="row"><a href="#card-' + esc(m.id) + '">' + esc(m.model) + "</a><br><small>" + esc(m.provider) + "</small>" +
          (r.rank === 1 ? '<span class="pick-tag">Best pick</span>' : "") + "</th>" +
        td(2, "num score-cell", "<strong>" + r.total + "</strong>") +
        ["cost", "quality", "latency", "context", "privacy"].map(function (k, i) { return td(3 + i, "num", String(pct(c[k]))); }).join("") +
        td(8, "num money", costCell(r, p)) +
        td(9, "num", fmtPrice(m.input_price_per_mtok) + " / " + fmtPrice(m.output_price_per_mtok)) +
        td(10, "num", esc(fmtTokens(m.context_window)) + (m.unverified_fields && m.unverified_fields.indexOf("context_window") >= 0 ? "*" : "")) +
        td(11, "wide-cell", dataBadge(m)) + "</tr>";
    }).join("");
    $("compare-body").innerHTML = rows || '<tr class="empty-row"><td colspan="12">No candidates. Every model was excluded by a hard constraint.</td></tr>';
    $("result-count").textContent = res.ranked.length + " ranked, " + res.excluded.length + " excluded by hard constraints.";

    // cards
    var cards = $("cards");
    cards.classList.toggle("is-reveal", reveal);
    cards.innerHTML = res.ranked.length ? res.ranked.map(function (r, idx) {
      var m = r.model, c = r.components;
      var flags = dataFlags(m, state.now).map(function (f) { return '<li class="' + f.level + '">' + esc(f.text) + "</li>"; })
        .concat(r.flags.map(function (f) { return '<li class="warn">' + esc(f) + "</li>"; }))
        .concat(r.notes.map(function (f) { return '<li class="info">' + esc(f) + "</li>"; }));
      if (m.live && m.live.changes.length) flags.push('<li class="info">Live data changed: ' + esc(m.live.changes.join("; ")) + ".</li>");
      return '<article class="card' + (r.rank === 1 ? " is-top" : "") + '" id="card-' + esc(m.id) + '" style="--i:' + Math.min(idx, 8) + '">' +
        (r.rank === 1 ? BEST_FLAG : "") +
        '<header class="card-head"><span class="rank">#' + r.rank + "</span>" +
          "<div><h3>" + esc(m.model) + '</h3><span class="provider">' + esc(m.provider) + "</span></div>" +
          '<span class="card-score">' + r.total + "<small>of 100</small></span></header>" +
        '<div class="card-cost"><span class="figure-label">Monthly</span>' + costFigure(r, p) + "</div>" +
        '<dl class="breakdown">' + ["cost", "quality", "latency", "context", "privacy"].map(function (k) {
          return "<dt>" + COMPONENT_LABELS[k] + "</dt><dd>" + bar(c[k]) + " " + pct(c[k]) + "</dd>";
        }).join("") + "</dl>" +
        '<p class="reason"><strong>Why this model:</strong> ' + esc(r.explain.why) + "</p>" +
        '<p class="reason"><strong>Trade-offs:</strong> ' + esc(r.explain.tradeoffs) + "</p>" +
        '<p class="facts">' + "Price in/out per 1M tokens: " + fmtPrice(m.input_price_per_mtok) + " / " + fmtPrice(m.output_price_per_mtok) +
        ". Context: " + esc(fmtTokens(m.context_window)) + ". Speed: " + esc(m.latency_class || "not rated") +
        ". Quality tier: " + (m.quality_tier != null ? m.quality_tier + " of 5 (editorial)" : "not rated") +
        ". Open weights: " + (m.open_weights ? "yes" : "no") + ". Monthly: " + costCell(r, p) + ".</p>" +
        (capsText(m) ? '<p class="facts">' + esc(capsText(m)) + "</p>" : "") +
        (extraPricesText(m) ? '<p class="facts">' + esc(extraPricesText(m)) + "</p>" : "") +
        (m.strengths.length ? '<p class="facts"><strong>Strengths:</strong> ' + esc(m.strengths.join("; ")) + ".</p>" : "") +
        (m.limits.length ? '<p class="facts"><strong>Limits:</strong> ' + esc(m.limits.join("; ")) + ".</p>" : "") +
        flagList(flags) +
        '<p class="source">Source: <a href="' + esc(safeUrl(m.source.url)) + '" rel="noopener">' + esc(m.source.name) + "</a>. " + dataBadge(m) + "</p>" +
        askButton(m) +
        "</article>";
    }).join("") : '<p class="cards-empty">No model cards to show: every candidate failed a hard constraint. Loosen one in the profile above.</p>';
    applyCardLimit();

    // excluded
    $("excluded").innerHTML = res.excluded.length ? res.excluded.map(function (r) {
      return "<li><strong>" + esc(r.model.model) + "</strong> (" + esc(r.model.provider) + "): " + esc(r.excludeReason) + "</li>";
    }).join("") : "<li>None. Every model passed the hard constraints.</li>";

    renderValueMap(res, p);
    renderCompare(res, p);
    renderSwitchOptions();
    renderSwitch();
    renderMarket(res, p);
    renderWhatIf();
    syncUrl();
  }

  /** "Cheaper option within 5 points" under the top pick. */
  function altHtml(alt) {
    if (!alt) return "";
    return '<p class="alt-pick"><span class="figure-label">Cheaper option within ' + SWITCH_MARGIN + ' points</span>' +
      '<a href="#card-' + esc(alt.model.id) + '">' + esc(alt.model.model) + "</a> scores " + alt.total + " (rank #" + alt.rank + ") for " +
      esc(fmtMoney(alt.cost)) + " a month: " + esc(fmtMoney(alt.saves)) + " less than the top pick, " + alt.gap + " points behind.</p>";
  }

  // ----- value map -----
  function mapPoints(res, p) {
    return res.ranked.map(function (r) {
      return { id: r.model.id, name: r.model.model, rank: r.rank, cost: monthlyCost(r.model, p.inputTokens, p.outputTokens, p), score: r.total, top: r.rank === 1 };
    });
  }

  function renderValueMap(res, p) {
    var box = $("value-map"), out = $("value-map-readout"), pts = mapPoints(res, p);
    var priced = pts.filter(function (q) { return isNum(q.cost) && q.cost > 0; });
    if (!priced.length) {
      box.innerHTML = '<p class="muted vm-empty">' + (res.ranked.length ? "Set a monthly volume above zero to place the models on the cost axis." : "No model to plot: every candidate failed a hard constraint.") + "</p>";
      out.textContent = "";
      state.mapFront = [];
      return;
    }
    var vm = valueMapSvg(pts, { xLabel: p.localOnly ? "Hosted reference cost per month (log scale)" : null, width: box.clientWidth });
    state.mapWidth = box.clientWidth;
    box.innerHTML = vm.svg;
    state.mapFront = vm.frontier;
    state.mapNote = vm.frontier.length + " of " + vm.plotted + " models sit on the frontier" + (vm.skipped ? ". " + vm.skipped + " with unknown prices are not shown" : "") + ".";
    out.textContent = state.mapNote;
    // Keep the keyboard cursor on the same model across re-renders, or drop it if that model left the map.
    if (state.mapCursorId && mapOrder("cost").indexOf(state.mapCursorId) < 0) state.mapCursorId = null;
    if (state.mapCursorId && document.activeElement === box) mapCursor(state.mapCursorId);
  }

  /** Plotted model ids in cost order (cheapest first) or score order (highest first). */
  function mapOrder(by) {
    var res = state.lastRes, p = state.lastProfile;
    if (!res || !p) return [];
    var pts = mapPoints(res, p).filter(function (q) { return isNum(q.cost) && q.cost > 0; });
    pts.sort(by === "score" ? function (a, b) { return b.score - a.score || a.cost - b.cost; } : function (a, b) { return a.cost - b.cost || b.score - a.score; });
    return pts.map(function (q) { return q.id; });
  }

  /** Mark one dot as the keyboard cursor (or none) and announce it. */
  function mapCursor(id) {
    state.mapCursorId = id || null;
    Array.prototype.forEach.call($("value-map").querySelectorAll("circle[data-id]"), function (c) {
      c.classList.toggle("is-cursor", !!id && c.getAttribute("data-id") === id);
    });
    mapReadout(id || null);
  }

  function mapKey(e) {
    var key = e.key, cost = mapOrder("cost");
    if (!cost.length) return;
    var cur = state.mapCursorId, next = null;
    if (key === "Enter" || key === " ") { if (cur) { e.preventDefault(); openCard(cur); } return; }
    if (key === "Escape") { if (cur) { e.preventDefault(); mapCursor(null); } return; }
    if (key === "ArrowLeft" || key === "ArrowRight") {
      var i = cost.indexOf(cur);
      next = cost[i < 0 ? 0 : clamp(i + (key === "ArrowRight" ? 1 : -1), 0, cost.length - 1)];
    } else if (key === "ArrowUp" || key === "ArrowDown") {
      var score = mapOrder("score"), j = score.indexOf(cur);
      next = score[j < 0 ? 0 : clamp(j + (key === "ArrowUp" ? -1 : 1), 0, score.length - 1)];
    } else if (key === "Home") next = cost[0];
    else if (key === "End") next = cost[cost.length - 1];
    else return;
    e.preventDefault();
    mapCursor(next);
  }

  function mapReadout(id) {
    var res = state.lastRes, out = $("value-map-readout");
    if (!res) return;
    if (!id) { out.textContent = state.mapNote || ""; return; }
    var r = res.ranked.filter(function (x) { return x.model.id === id; })[0];
    if (!r) return;
    var p = state.lastProfile, mc = monthlyCost(r.model, p.inputTokens, p.outputTokens, p);
    out.textContent = "#" + r.rank + " " + r.model.model + " (" + r.model.provider + "): score " + r.total + ", " + fmtMoney(mc) + " a month." +
      ((state.mapFront || []).indexOf(id) >= 0 ? " On the frontier." : "");
  }

  /** Scroll to a model card, opening the folded cards first if needed. */
  function openCard(id) {
    var card = document.getElementById("card-" + id);
    if (!card) return;
    if (card.hidden) { state.showAllCards = true; applyCardLimit(); }
    if (card.scrollIntoView) card.scrollIntoView({ block: "start" });
    if (typeof card.focus === "function") { card.setAttribute("tabindex", "-1"); card.focus({ preventScroll: true }); }
  }

  // ----- compare tray and head to head -----
  function toggleCompare(id) {
    var i = state.compare.indexOf(id), note = "";
    if (i >= 0) state.compare.splice(i, 1);
    else {
      if (state.compare.length >= COMPARE_MAX) {
        var dropped = state.compare.shift(), r = state.lastRes && state.lastRes.ranked.filter(function (x) { return x.model.id === dropped; })[0];
        note = " Compare holds " + COMPARE_MAX + " models, so " + (r ? r.model.model : "the oldest pick") + " was taken out.";
      }
      state.compare.push(id);
    }
    state.compareNote = note;
    renderCompare(state.lastRes, state.lastProfile);
  }

  function renderCompare(res, p) {
    if (!res) return;
    var byId = {};
    res.ranked.forEach(function (r) { byId[r.model.id] = r; });
    var picked = state.compare.map(function (id) { return byId[id]; }).filter(Boolean);
    var gone = state.compare.filter(function (id) { return !byId[id]; });
    Array.prototype.forEach.call(document.querySelectorAll(".compare-btn"), function (b) {
      var on = state.compare.indexOf(b.getAttribute("data-compare")) >= 0;
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.firstChild.nodeValue = on ? "In comparison" : "Compare";
    });
    // tray
    var tray = $("compare-tray");
    tray.hidden = !state.compare.length;
    document.body.classList.toggle("has-tray", !!state.compare.length);
    var names = picked.map(function (r) { return r.model.model; });
    $("compare-tray-text").textContent = !state.compare.length ? "" :
      (picked.length < 2 ? "Comparing " + (names[0] || "nothing ranked") + ". Pick one or two more with Compare on the cards." :
        "Comparing " + picked.length + ": " + names.join(", ") + ".") +
      (gone.length ? " " + gone.length + " picked model" + (gone.length > 1 ? "s are" : " is") + " excluded by the current profile." : "") + (state.compareNote || "");
    $("compare-tray-go").hidden = picked.length < 2;
    // head to head
    var sec = $("h2h");
    sec.hidden = picked.length < 2;
    if (picked.length < 2) return;
    var h = headToHead(picked, p);
    var head = '<thead><tr><th scope="col"><span class="visually-hidden">Figure</span></th>' + picked.map(function (r) {
      return '<th scope="col"><span class="h2h-rank">#' + r.rank + "</span> " + esc(r.model.model) + "<small>" + esc(r.model.provider) + "</small>" +
        '<button type="button" class="h2h-remove" data-compare="' + esc(r.model.id) + '">Remove<span class="visually-hidden"> ' + esc(r.model.model) + "</span></button></th>";
    }).join("") + "</tr></thead>";
    var body = "<tbody>" + h.rows.map(function (row) {
      return '<tr><th scope="row">' + esc(row.label) + "</th>" + row.cells.map(function (c, i) {
        var best = row.best.indexOf(i) >= 0;
        return "<td" + (best ? ' class="is-best"' : "") + ">" + esc(c) + (best ? ' <span class="h2h-best">best</span>' : "") + "</td>";
      }).join("") + "</tr>";
    }).join("") + "</tbody>";
    $("h2h-table").innerHTML = head + body;
    var askable = picked.filter(function (r) { return r.model.openrouter_id && r.model.kind !== "embedding"; });
    $("h2h-ask").disabled = askable.length < 2;
    $("h2h-ask").textContent = askable.length < 2 ? "Side by side needs two models listed on OpenRouter" : "Ask " + askable[0].model.model + " and " + askable[1].model.model + " side by side";
    $("h2h-lede").textContent = "The " + picked.length + " models you picked with Compare, under your current profile. The better figure in each row is marked; prices are list prices per million tokens.";
  }

  function askPairSideBySide() {
    var res = state.lastRes, byId = {};
    if (!res) return;
    res.ranked.forEach(function (r) { byId[r.model.id] = r; });
    var pair = state.compare.map(function (id) { return byId[id]; }).filter(function (r) { return r && r.model.openrouter_id && r.model.kind !== "embedding"; }).slice(0, 2);
    if (pair.length < 2) return;
    pair.forEach(function (r) {
      var listed = Array.prototype.some.call($("side-model-a").options, function (o) { return o.value === r.model.openrouter_id; });
      if (!listed) chat.extra.push({ openrouter_id: r.model.openrouter_id, model: r.model.model });
    });
    fillChatPickers();
    var note = "";
    if (chatProvider() === "local") {
      $("chat-provider-openrouter").checked = true;
      applyProvider();
      note = " Switched the provider to OpenRouter, because local mode only runs dolphin3.";
    }
    $("chat-mode-side").checked = true;
    applyMode();
    $("side-model-a").value = pair[0].model.openrouter_id;
    $("side-model-b").value = pair[1].model.openrouter_id;
    chat.side = [null, null];
    renderSideIdle();
    chatNote("Left: " + pair[0].model.model + ". Right: " + pair[1].model.model + "." + note + " Type one question for both.", "ok");
    var panel = $("chat-main");
    if (panel.scrollIntoView) panel.scrollIntoView({ block: "start" });
    $("side-input").focus();
  }

  // ----- decision memo -----
  function memoText() {
    var p = readProfile(), res = rankModels(candidates(), p, state.now);
    return decisionMemo({
      res: res, p: p, description: $("task-desc").value, rb: robustness(res), alt: cheaperAlternative(res.ranked, p), tips: tippingPoints(res),
      whatIf: whatIfs(candidates(), readSettings(), state.now),
      now: new Date(), catalogDate: state.catalog && state.catalog.catalog_date,
      liveAt: state.live && state.live.ok ? state.live.fetchedAt.toLocaleString() : null, link: shareUrl()
    });
  }

  function copyMemo() {
    var text = memoText(), out = $("share-status");
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(function () {
        out.textContent = "Decision memo copied as Markdown. It includes your description, so check it before you share it.";
      }, function () { out.textContent = "This browser blocked the clipboard. Use Download memo instead."; });
    } else out.textContent = "This browser blocked the clipboard. Use Download memo instead.";
  }

  function downloadMemo() {
    var text = memoText(), out = $("share-status");
    try {
      var url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
      var a = document.createElement("a");
      a.href = url;
      a.download = "model-choice-" + new Date().toISOString().slice(0, 10) + ".md";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      out.textContent = "Memo saved as " + a.download + ". It includes your description, so check it before you share it.";
    } catch (e) { out.textContent = "This browser could not save the file. Use Copy decision memo instead."; }
  }

  /** Only the first CARD_LIMIT cards show until the reader asks for all of them. */
  function applyCardLimit() {
    var list = $("cards").querySelectorAll(".card"), btn = $("cards-toggle"), extra = list.length - CARD_LIMIT;
    Array.prototype.forEach.call(list, function (c, i) { c.hidden = !state.showAllCards && i >= CARD_LIMIT; });
    btn.hidden = extra <= 0;
    btn.setAttribute("aria-expanded", state.showAllCards ? "true" : "false");
    btn.textContent = state.showAllCards ? "Show only the top " + CARD_LIMIT : "Show all " + list.length + " model cards";
    $("cards-lede").textContent = extra > 0 && !state.showAllCards ?
      "The top " + CARD_LIMIT + " of " + list.length + " ranked models, with their reasons, trade-offs, capabilities, source, and data status. Every model is in the table above." :
      "Every ranked model, with its reasons, trade-offs, capabilities, source, and data status.";
  }

  /** Keep the page address in step with the settings once the reader has changed something, so it can be shared. */
  function syncUrl() {
    if (!state.touched || !window.history || typeof history.replaceState !== "function") return;
    var qs = encodeSettings(readSettings());
    try { history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash); } catch (e) { /* file:// in some browsers */ }
  }

  function shareUrl() {
    var qs = encodeSettings(readSettings());
    return location.href.split(/[?#]/)[0] + (qs ? "?" + qs : "") + "#results";
  }

  function copyShareLink() {
    var url = shareUrl(), out = $("share-status");
    function done(ok) {
      out.textContent = ok ? "Link copied. It holds your settings, not your description." : "Copy this link by hand: " + url;
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); });
    } else done(false);
  }

  // ----- presets and the volume helper -----
  function renderPresets() {
    $("preset-list").innerHTML = PRESETS.map(function (pr) {
      return '<button type="button" class="preset" data-preset="' + esc(pr.id) + '" aria-pressed="false">' + esc(pr.name) + "</button>";
    }).join("");
    $("presets").hidden = false;
  }

  function markPreset(id) {
    Array.prototype.forEach.call($("preset-list").querySelectorAll(".preset"), function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-preset") === id ? "true" : "false");
    });
  }

  function usePreset(id) {
    var s = presetSettings(id), pr = PRESETS.filter(function (x) { return x.id === id; })[0];
    if (!s || !pr) return;
    dropLeverUndo();
    applySettings(s);
    $("task-desc").value = pr.description;
    markPreset(id);
    $("preset-result").textContent = "Loaded " + pr.name + ": every field below now matches that case. Volumes are examples, so set your own.";
    $("suggest-result").textContent = "";
    state.touched = true;
    render();
  }

  function helperVolume() {
    function v(id) { var x = parseFloat($(id).value); return isFinite(x) && x > 0 ? x : 0; }
    var d = v("req-day"), i = v("req-in"), o = v("req-out");
    return { ready: d > 0 && (i > 0 || o > 0), vol: volumeFromRequests(d, i, o) };
  }

  function fmtMillions(x) { return String(x >= 100 ? Math.round(x) : x >= 1 ? round(x, 2) : Math.max(round(x, 4), x > 0 ? 0.0001 : 0)); }

  function renderHelper() {
    var h = helperVolume(), out = $("req-readout");
    $("req-apply").disabled = !h.ready;
    out.textContent = !h.ready ? "Fill in the three numbers to see the monthly volume." :
      "About " + Math.round(h.vol.requests).toLocaleString("en-US") + " requests a month: " + fmtMillions(h.vol.inputM) +
      " million input and " + fmtMillions(h.vol.outputM) + " million output tokens.";
  }

  function applyHelper() {
    var h = helperVolume();
    if (!h.ready) return;
    applySettings({ inputM: Number(fmtMillions(h.vol.inputM)), outputM: Number(fmtMillions(h.vol.outputM)) });
    $("req-readout").textContent += " Copied into the volume fields.";
    state.touched = true;
    render();
  }

  function readSample() { return sampleEstimate($("sample-fixed").value, $("sample-var").value, $("sample-reply").value); }

  function sampleText(e, applied) {
    function n(x) { return x.toLocaleString("en-US"); }
    if (e.input + e.output === 0) return "Paste a message or a reply to count its tokens.";
    var t = "About " + n(e.input) + " input tokens per request" +
      (e.fixed && e.variable ? " (" + n(e.fixed) + " repeated, " + n(e.variable) + " that change)" : "") +
      " and " + n(e.output) + " output tokens.";
    if (!e.fixed) return t;
    var pct = Math.round(e.repeatedShare * 100) + "%";
    if (e.cacheTooShort) return t + " The repeated part is under " + n(CACHE_MIN_TOKENS) + " tokens, below the minimum many providers cache, so the cache share is left as it is.";
    if (!e.cacheShare) return t + " Only " + pct + " of the input repeats, so the cache share is left as it is.";
    return t + " " + pct + " of the input repeats, so the cache share " + (applied ? "is now " : "will be set to ") + Math.round(e.cacheShare * 100) + "%. Caching needs the repeated part at the start of the prompt.";
  }

  function renderSample() {
    var e = readSample();
    $("sample-apply").disabled = e.input + e.output === 0;
    $("sample-readout").textContent = sampleText(e);
  }

  function applySample() {
    var e = readSample();
    if (e.input + e.output === 0) return;
    $("req-in").value = String(e.input);
    $("req-out").value = String(e.output);
    if (e.cacheShare && parseFloat($("cache-share").value) !== e.cacheShare) {
      applySettings({ cacheShare: e.cacheShare });
      markPreset("");
      state.touched = true;
      dropLeverUndo();
      render();
    }
    renderHelper();
    $("sample-readout").textContent = sampleText(e, true) + " Copied into the request fields below.";
    if (!$("req-day").value) $("req-day").focus();
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

  // ----- what if -----
  function renderWhatIf() {
    var list = $("whatif"), w = whatIfs(candidates(), readSettings(), state.now);
    state.lastWhatIf = w;
    if (!w) { list.innerHTML = '<li class="wi-none">Nothing is ranked under the current settings, so there is nothing to compare.</li>'; return; }
    if (!w.levers.length) {
      list.innerHTML = '<li class="wi-none">No single change moves the pick or saves 5% or more. ' + esc(w.base.top.model) + " holds up.</li>";
      return;
    }
    list.innerHTML = w.levers.map(function (lv, i) {
      var out;
      if (!lv.top) out = "Nothing passes every hard constraint.";
      else {
        out = (lv.pickChanged ? "<strong>" + esc(lv.top.model) + "</strong> comes first" : "Same pick");
        if (lv.selfHosted) out += ", self-hosted: the cost is your hardware.";
        else if (lv.delta === null) out += ", about " + esc(fmtMoney(lv.cost)) + " a month.";
        else if (lv.delta < 0) out += ', <span class="wi-save">' + esc(fmtMoney(-lv.delta)) + "</span> a month less (" + esc(fmtMoney(lv.cost)) + ").";
        else if (lv.delta > 0) out += ', <span class="wi-cost">' + esc(fmtMoney(lv.delta)) + "</span> a month more (" + esc(fmtMoney(lv.cost)) + ").";
        else out += ", same monthly cost.";
      }
      return '<li class="wi' + (lv.pickChanged ? " is-new" : "") + '"><p class="wi-label">' + esc(lv.label) + '</p><p class="wi-out">' + out + "</p>" +
        '<button type="button" class="btn btn-small" data-lever="' + i + '" aria-label="Apply: ' + esc(lv.label) + '">Apply</button></li>';
    }).join("");
  }

  function applyLever(i) {
    var lv = state.lastWhatIf && state.lastWhatIf.levers[i];
    if (!lv) return;
    state.leverUndo = readSettings();
    applySettings(lv.settings);
    state.touched = true;
    markPreset("");
    render();
    $("whatif-status").textContent = "Applied: " + lv.label + ". The form above now shows it.";
    $("whatif-undo").hidden = false;
    $("whatif-undo").focus();
  }

  /** Any other edit makes the saved settings out of date, so Undo goes away. */
  function dropLeverUndo() {
    if (!state.leverUndo) return;
    state.leverUndo = null;
    $("whatif-undo").hidden = true;
    $("whatif-status").textContent = "";
  }

  function undoLever() {
    if (!state.leverUndo) return;
    applySettings(state.leverUndo);
    state.leverUndo = null;
    render();
    $("whatif-status").textContent = "Undone: the settings are back to what they were.";
    $("whatif-undo").hidden = true;
    var first = $("whatif").querySelector("[data-lever]");
    if (first) first.focus();
  }

  // ----- market watch -----
  var MW_ROWS = 6;

  function agoText(d) { return d === 0 ? "today" : d === 1 ? "yesterday" : d + " days ago"; }
  function untilText(x) {
    if (x.past) return "retired " + agoText(-x.days) + ", still listed";
    return x.days === 0 ? "retires today" : x.days === 1 ? "retires tomorrow" : "retires in " + x.days + " days";
  }
  function rankIn(res, id) {
    var hit = null;
    (res && res.ranked || []).forEach(function (r) { if (r.model.id === id) hit = r; });
    return hit;
  }
  /** A model's name, linked to its card when it is ranked, otherwise to its source page. */
  function mwLink(m, res) {
    if (rankIn(res, m.id)) return '<a href="#card-' + esc(m.id) + '">' + esc(m.model) + "</a>";
    return '<a href="' + esc(safeUrl(m.source && m.source.url)) + '" rel="noopener">' + esc(m.model) + "</a>";
  }
  function mwBadge(m) { return m.liveOnly ? "" : '<span class="badge ok">Reviewed</span>'; }

  /** Does a market entry pass the profile's hard limits, and what would it cost at this volume? */
  function mwFit(m, res, p) {
    var r = scoreModel(m, p, res.weights, state.now), top = res.ranked[0];
    if (r.excluded) return '<p class="mw-fit is-out">Ruled out for you: ' + esc(r.excludeReason) + "</p>";
    var bits = [], ranked = rankIn(res, m.id), mc = monthlyCost(m, p.inputTokens, p.outputTokens, p);
    if (ranked) bits.push("Ranks #" + ranked.rank + " for you.");
    if (!p.localOnly && mc !== null) {
      bits.push("About " + fmtMoney(mc) + " a month at your volume" +
        (top && top.model.id !== m.id ? " (your top pick: " + fmtMoney(monthlyCost(top.model, p.inputTokens, p.outputTokens, p)) + ")." : "."));
    }
    return '<p class="mw-fit is-in"><strong>Fits your hard limits.</strong> ' + esc(bits.join(" ")) + "</p>";
  }

  function mwList(id, rows, open, more, empty) {
    $(id).innerHTML = rows.length ? rows.map(function (h, i) { return h.replace("<li", "<li" + (!open && i >= MW_ROWS ? " hidden" : "")); }).join("") :
      '<li class="mw-empty">' + esc(empty) + "</li>";
    var btn = $(more);
    if (!btn) return;
    btn.hidden = rows.length <= MW_ROWS;
    btn.setAttribute("aria-expanded", String(!!open));
    btn.textContent = open ? "Show fewer" : "Show all " + rows.length;
  }

  function renderMarket(res, p) {
    var live = state.live && state.live.ok, catDate = state.catalog ? state.catalog.catalog_date : "unknown";
    var entries = state.base.concat(live ? state.liveOnly : []);
    var mw = marketWatch(entries, state.now), top = res.ranked[0];
    var current = $("current-model") ? $("current-model").value : "";
    $("mw-days").textContent = String(mw.days);
    $("market-source").textContent = live ?
      "From OpenRouter's public model list, fetched " + state.live.fetchedAt.toLocaleString() + ". Free, batch, and other variants are left out; new means first listed in the last " + mw.days + " days." :
      state.live ? "OpenRouter's live list did not load (" + state.live.error + "), so this shows only what the bundled snapshot of " + catDate + " knows about the " + state.base.length + " reviewed models." :
      "Checking OpenRouter's live list...";

    $("mw-fresh-count").textContent = mw.fresh.length ? String(mw.fresh.length) : "";
    var unreviewed = mw.fresh.filter(function (x) { return !x.reviewed; }).length, incl = $("include-live").checked;
    $("mw-fresh-note").hidden = !unreviewed;
    $("mw-fresh-note-text").textContent = unreviewed + " of these " + (unreviewed === 1 ? "is" : "are") + " not reviewed by Model Scout, so quality and speed are not rated. " +
      (incl ? "They are in the ranking now, scored as average on both." : "They join the ranking, scored as average on both, when you include live models.");
    $("mw-include").textContent = incl ? "Rank reviewed models only" : "Include live models in the ranking";
    mwList("mw-fresh", mw.fresh.map(function (x) {
      var m = x.model;
      return '<li class="mw-row">' +
        '<p class="mw-name">' + mwLink(m, res) + ' <span class="provider">' + esc(m.provider) + "</span> " + mwBadge(m) + "</p>" +
        '<p class="mw-facts">Listed ' + esc(agoText(x.days)) + " (" + esc(m.listed_on) + "). " + fmtPrice(m.input_price_per_mtok) + " in / " +
          fmtPrice(m.output_price_per_mtok) + " out per 1M. " + esc(fmtTokens(m.context_window)) + " context.</p>" +
        mwFit(m, res, p) + "</li>";
    }), state.mwOpen.fresh, "mw-fresh-more",
      live ? "Nothing new on OpenRouter in the last " + mw.days + " days." : "No reviewed model was first listed in the last " + mw.days + " days. The live list would show the rest.");

    $("mw-moves-count").textContent = mw.moves.length ? String(mw.moves.length) : "";
    mwList("mw-moves", mw.moves.map(function (x) {
      var m = x.model, b = m.live.before;
      function side(label, d) {
        if (d.from === d.to) return label + " unchanged at " + fmtPrice(d.to);
        return label + " " + fmtPrice(d.from) + " to " + fmtPrice(d.to) + (d.pct === null ? "" : " (" + (d.pct < 0 ? "down " : "up ") + Math.abs(d.pct) + "%)");
      }
      var was = monthlyCost({ input_price_per_mtok: b.input, output_price_per_mtok: b.output }, p.inputTokens, p.outputTokens);
      var now = monthlyCost(m, p.inputTokens, p.outputTokens);
      var cls = (x.input.pct || 0) + (x.output.pct || 0) < 0 ? " is-down" : " is-up";
      return '<li class="mw-row' + cls + '">' +
        '<p class="mw-name">' + mwLink(m, res) + ' <span class="provider">' + esc(m.provider) + "</span></p>" +
        '<p class="mw-facts">' + esc(side("Input", x.input) + "; " + side("output", x.output)) + " per 1M, since " + esc(x.since || catDate) + ".</p>" +
        (was !== null && now !== null && !p.localOnly ? '<p class="mw-fit">At your volume, before cache and batch discounts: ' + esc(fmtMoney(was)) + " to " + esc(fmtMoney(now)) + " a month.</p>" : "") +
        "</li>";
    }), true, null,
      live ? "No changes: every reviewed model OpenRouter lists costs the same as in the snapshot of " + catDate + "." :
      "Needs the live list to compare prices with the snapshot of " + catDate + ".");

    $("mw-retire-count").textContent = mw.retiring.length ? String(mw.retiring.length) : "";
    mwList("mw-retire", mw.retiring.map(function (x) {
      var m = x.model, tags = [];
      if (top && top.model.id === m.id) tags.push('<span class="badge warn">Your top pick</span>');
      if (current && current === m.id) tags.push('<span class="badge warn">The model you use today</span>');
      var ranked = rankIn(res, m.id);
      return '<li class="mw-row' + (tags.length ? " is-yours" : "") + (x.past ? " is-past" : "") + '">' +
        '<p class="mw-name">' + mwLink(m, res) + ' <span class="provider">' + esc(m.provider) + "</span> " + mwBadge(m) + " " + tags.join(" ") + "</p>" +
        '<p class="mw-facts"><strong>' + esc(untilText(x).charAt(0).toUpperCase() + untilText(x).slice(1)) + "</strong> (" + esc(x.on) + ")." +
          (ranked ? " Ranks #" + ranked.rank + " for you." : "") + "</p></li>";
    }), state.mwOpen.retire, "mw-retire-more",
      live ? "No retirement dates announced for any listed model." : "No retirement dates in the bundled snapshot. The live list may know more.");
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
    if (r.retirement) html += '<p class="verdict warn">' + esc(r.retirement.text) + "</p>";
    out.innerHTML = html;
  }

  function renderStatus() {
    var c = state.catalog, st = staleStatus({ last_verified: c.catalog_date }, state.now, c.stale_after_days);
    var html = '<p><strong>Bundled catalog dated ' + esc(c.catalog_date) + "</strong> (" + state.base.length + " models, " +
      (st.ageDays != null ? st.ageDays + (st.ageDays === 1 ? " day old" : " days old") : "age unknown") + ", loaded from " + esc(state.catalogOrigin) + "). ";
    if (st.stale) html += '<span class="badge stale">Stale</span> This catalog is older than ' + c.stale_after_days + " days. Treat prices as possibly out of date. ";
    html += "</p>";
    var L = state.live;
    if (!L) html += '<p class="loading-line"><span class="spinner" aria-hidden="true"></span>Checking OpenRouter for live prices...</p>';
    else if (L.ok) {
      html += '<p><span class="badge live">Live</span> OpenRouter model list fetched ' + esc(L.fetchedAt.toLocaleString()) +
        ": " + L.matched + " catalog models updated with live prices" + (L.changed.length ? " (" + L.changed.length + " changed since the bundled snapshot)" : ", none changed since the bundled snapshot") +
        ". " + L.liveOnly + " other live models are available with the checkbox above the results.</p>";
    } else {
      html += '<p><span class="badge warn">Offline</span> Live data unavailable (' + esc(L.error) + "). Using the bundled catalog dated " + esc(c.catalog_date) + ".</p>";
    }
    var box = $("data-status");
    box.innerHTML = html;
    box.setAttribute("data-state", !L ? "loading" : !L.ok ? "offline" : st.stale ? "stale" : "live");
    $("include-live").disabled = !(L && L.ok);
    $("include-live-help").textContent = !L ? "Turns on once the live OpenRouter list has loaded." :
      L.ok ? L.liveOnly + " unreviewed live models are available." : "Unavailable: live data could not be loaded.";
  }

  function applySuggestions() {
    var s = suggestFromText($("task-desc").value);
    var out = $("suggest-result");
    if (!s.why.length) { out.textContent = "No keywords matched. Set the fields below by hand."; return; }
    applySettings(s.settings);
    markPreset("");
    out.textContent = "Updated settings because your description " + s.why.join(", ") + ". This is simple keyword matching: check the fields.";
    state.touched = true;
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
      state.liveIds = {};
      j.data.forEach(function (x) { if (x && x.id) state.liveIds[x.id] = true; });
      var m = mergeLive(state.catalog.models, j.data, at);
      state.base = m.models;
      state.liveOnly = m.liveOnly;
      state.live = { ok: true, fetchedAt: at, matched: m.matched, changed: m.changed, liveOnly: m.liveOnly.length };
    }).catch(function (e) {
      state.live = { ok: false, error: e && e.name === "AbortError" ? "timed out" : "blocked, offline, or failed: " + (e && e.message ? e.message : "unknown error") };
    }).then(function () { clearTimeout(timer); });
  }

  // ---------- Ask a model: chat panel, key box, side by side ----------
  // chat.side holds the last state of each side-by-side column (null = follow the picker).
  var chat = { entries: [], busy: false, sideBusy: false, extra: [], side: [null, null] };

  function keyStorage() { try { return window.localStorage; } catch (e) { return null; } }
  function chatFetch(url, init) { return fetch(url, init); }
  function chatProvider() { return $("chat-provider-local").checked ? "local" : "openrouter"; }
  function chatMode() { return $("chat-mode-side").checked ? "side" : "single"; }

  /** The button at the foot of every model card. Models that cannot chat get a disabled button and the reason. */
  function askButton(m) {
    var on = state.compare.indexOf(m.id) >= 0;
    var cmp = '<button type="button" class="btn compare-btn" data-compare="' + esc(m.id) + '" aria-pressed="' + on + '">' +
      (on ? "In comparison" : "Compare") + '<span class="visually-hidden">: ' + esc(m.model) + "</span></button>";
    if (m.kind === "embedding" || !m.openrouter_id) {
      var nid = "ask-note-" + m.id;
      return '<div class="card-actions"><div class="row">' + cmp + '<button type="button" class="btn ask-btn" disabled aria-describedby="' + esc(nid) + '">Ask this model</button></div>' +
        '<small id="' + esc(nid) + '">' + (m.kind === "embedding" ? "Embedding models make search vectors and cannot chat." :
          "Not listed on OpenRouter, so it cannot be asked from here.") + "</small></div>";
    }
    return '<div class="card-actions"><div class="row">' + cmp + '<button type="button" class="btn ask-btn" data-ask="' + esc(m.openrouter_id) + '" data-name="' + esc(m.model) + '">' +
      'Ask this model<span class="visually-hidden">: ' + esc(m.model) + "</span></button></div></div>";
  }

  /** Every model the chat can name: featured, catalog (with live prices once loaded), live-only, and models added from cards. */
  function chatPool() { return state.base.concat(state.liveOnly).concat(chat.extra); }

  function chatModelLabel(id) {
    if (!id) return "";
    var i, pool = chatPool();
    for (i = 0; i < FEATURED_CHAT_MODELS.length; i++) if (FEATURED_CHAT_MODELS[i].id === id) return FEATURED_CHAT_MODELS[i].name;
    for (i = 0; i < pool.length; i++) if (pool[i].openrouter_id === id) return pool[i].model;
    return id;
  }

  function chatOptionsHtml(withEmpty) {
    var live = state.liveIds, seen = {};
    function opt(id, label) {
      seen[id] = true;
      var missing = live && !live[id] ? " (not in OpenRouter's live list today)" : "";
      return '<option value="' + esc(id) + '">' + esc(label + missing) + "</option>";
    }
    var html = withEmpty ? '<option value="">Choose a model</option>' : "";
    html += '<optgroup label="Suggested for chat">' + FEATURED_CHAT_MODELS.map(function (f) { return opt(f.id, f.name); }).join("") + "</optgroup>";
    var cat = state.base.filter(function (m) { return m.kind === "generation" && m.openrouter_id && !seen[m.openrouter_id]; })
      .sort(function (a, b) { return a.model.localeCompare(b.model); });
    if (cat.length) {
      html += '<optgroup label="From the Model Scout catalog">' + cat.map(function (m) { return opt(m.openrouter_id, m.model + " (" + m.provider + ")"); }).join("") + "</optgroup>";
    }
    var extra = chat.extra.filter(function (m) { return !seen[m.openrouter_id]; });
    if (extra.length) {
      html += '<optgroup label="Added from model cards">' + extra.map(function (m) { return opt(m.openrouter_id, m.model); }).join("") + "</optgroup>";
    }
    return html;
  }

  function refill(sel, withEmpty, fallback) {
    var prev = sel.value;
    sel.innerHTML = chatOptionsHtml(withEmpty);
    sel.value = prev;
    if (sel.value !== prev) sel.value = fallback;
  }

  function fillChatPickers() {
    refill($("chat-model"), false, DEFAULT_CHAT_MODEL);
    refill($("side-model-a"), true, "");
    refill($("side-model-b"), true, "");
    renderModelNote();
    renderSideIdle();
  }

  function renderModelNote() {
    var note = $("chat-model-note");
    if (chatProvider() === "local") { note.textContent = "Local mode always uses dolphin3 in Ollama. This picker applies to OpenRouter."; return; }
    var id = $("chat-model").value, text = "OpenRouter model id: " + id + ".", pool = chatPool();
    for (var i = 0; i < pool.length; i++) {
      var m = pool[i];
      if (m.openrouter_id === id && m.price_status === "live") {
        text += " Live price: " + fmtPrice(m.input_price_per_mtok) + " in / " + fmtPrice(m.output_price_per_mtok) + " out per 1M tokens.";
        break;
      }
    }
    if (state.liveIds && !state.liveIds[id]) text += " Not in OpenRouter's live model list today, so the request may fail.";
    note.textContent = text;
  }

  function chatNote(text, level) {
    var el = $("chat-status");
    el.textContent = text || "";
    if (level) el.setAttribute("data-level", level); else el.removeAttribute("data-level");
  }

  // ----- provider and mode -----
  function applyProvider() {
    var local = chatProvider() === "local";
    $("chat-key-box").hidden = local;
    $("chat-local-note").hidden = !local;
    $("chat-model").disabled = local;
    $("side-model-a").disabled = local;
    $("side-model-b").disabled = local;
    var check = localModeCheck(location.href), lc = $("chat-local-check");
    lc.textContent = check.text;
    lc.className = "verdict " + (check.ok ? "ok" : "warn");
    chat.side = chat.side.map(function (c) { return c && c.status === "idle" ? null : c; });
    renderModelNote();
    renderSideIdle();
  }

  function applyMode() {
    var side = chatMode() === "side";
    $("chat-single").hidden = side;
    $("chat-side").hidden = !side;
    chatNote("");
  }

  // ----- key box: localStorage only -----
  function renderKeyStatus() {
    var store = keyStorage(), k = readKey(store);
    $("chat-key-status").textContent = !store ? "This browser blocks local storage, so a key cannot be saved here. Local Ollama still works." :
      k ? "A key is saved in this browser, ending in " + k.slice(-4) + ". Paste a new key to replace it." : "No key saved yet.";
    $("chat-key-forget").disabled = !k;
  }

  function keyError(text) {
    $("chat-key-error").textContent = text || "";
    if (text) $("chat-key").setAttribute("aria-invalid", "true"); else $("chat-key").removeAttribute("aria-invalid");
  }

  function promptForKey() {
    keyError("Add your OpenRouter key to send: paste it here and press Save key. Or switch the provider to Local Ollama.");
    chatNote("No OpenRouter key saved yet. Add one in the key box.", "warn");
    $("chat-key").focus();
  }

  function saveKeyFromForm() {
    var store = keyStorage();
    var r = store ? saveKey(store, $("chat-key").value) : { ok: false, error: "This browser blocks local storage, so the key cannot be saved here." };
    if (!r.ok) { keyError(r.error); return; }
    $("chat-key").value = "";
    keyError("");
    renderKeyStatus();
    chatNote("Key saved in this browser only.", "ok");
  }

  function forgetKeyClick() {
    forgetKey(keyStorage());
    $("chat-key").value = "";
    keyError("");
    renderKeyStatus();
    chatNote("Key removed from this browser.", "ok");
  }

  // ----- single model chat -----
  function renderChatLog() {
    var log = $("chat-log");
    if (!chat.entries.length) {
      log.innerHTML = '<p class="chat-empty">No messages yet. Pick a model, type a question, and press Send. The conversation stays in this page and is gone when you reload.</p>';
      return;
    }
    log.innerHTML = chat.entries.map(function (e) {
      if (e.role === "user") return '<div class="msg msg-user"><p class="msg-who">You</p><div class="msg-text">' + esc(e.content) + "</div></div>";
      var who = '<p class="msg-who">' + esc(e.label) + "</p>";
      var text = e.content ? '<div class="msg-text">' + esc(e.content) + "</div>" : "";
      if (e.role === "pending") return '<div class="msg msg-model">' + who + (text || '<p class="loading-line"><span class="spinner" aria-hidden="true"></span>Waiting for the answer...</p>') + "</div>";
      if (e.role === "error") return '<div class="msg msg-model msg-error">' + who + text + '<p class="verdict warn">' + esc(e.error) + "</p></div>";
      return '<div class="msg msg-model">' + who + text + "</div>";
    }).join("");
    log.scrollTop = log.scrollHeight;
  }

  function setChatBusy(b) {
    chat.busy = b;
    $("chat-send").disabled = b;
    $("chat-send").textContent = b ? "Sending..." : "Send";
    $("chat-clear").disabled = b;
    $("chat-log").setAttribute("aria-busy", b ? "true" : "false");
  }

  /** What the API sees: user and assistant turns only, never error notes or pending placeholders. */
  function chatHistory() {
    return chat.entries.filter(function (e) { return e.role === "user" || e.role === "assistant"; })
      .map(function (e) { return { role: e.role, content: e.content }; });
  }

  function chatSend() {
    if (chat.busy) return;
    var text = $("chat-input").value.trim();
    if (!text) { chatNote("Type a message first.", "warn"); $("chat-input").focus(); return; }
    var provider = chatProvider(), key = "";
    if (provider === "openrouter") {
      key = readKey(keyStorage());
      if (!key) { promptForKey(); return; }
    }
    var model = provider === "local" ? LOCAL_MODEL : $("chat-model").value;
    var label = provider === "local" ? LOCAL_LABEL : chatModelLabel(model);
    chat.entries.push({ role: "user", content: text });
    var req = buildChatRequest(provider, model, chatHistory(), key, $("chat-stream").checked);
    var pending = { role: "pending", label: label, content: "", error: "" };
    chat.entries.push(pending);
    $("chat-input").value = "";
    chatNote("Sending to " + label + "...");
    setChatBusy(true);
    renderChatLog();
    sendChat(chatFetch, req, { pageUrl: location.href, onDelta: function (t) { pending.content = t; renderChatLog(); } }).then(function (r) {
      pending.role = r.ok ? "assistant" : "error";
      pending.content = r.text || "";
      pending.error = r.ok ? "" : r.error;
      setChatBusy(false);
      renderChatLog();
      chatNote(r.ok ? "Answer from " + label + "." : "The request failed: see the message in the conversation.", r.ok ? "" : "warn");
    });
  }

  // ----- side by side -----
  function sideColumnFor(i) {
    if (chatProvider() === "local") return { model: LOCAL_MODEL, label: LOCAL_LABEL };
    var id = i ? $("side-model-b").value : $("side-model-a").value;
    return { model: id, label: chatModelLabel(id) };
  }

  function renderSideCol(i, st) {
    var el = i ? $("side-col-b") : $("side-col-a");
    chat.side[i] = st;
    el.setAttribute("data-status", st.status || "idle");
    el.setAttribute("aria-busy", st.status === "sending" ? "true" : "false");
    el.innerHTML = sideColumnHtml(i ? "Right" : "Left", st);
  }

  /** Columns that are not showing an answer follow their picker. */
  function renderSideIdle() {
    [0, 1].forEach(function (i) {
      var cur = chat.side[i];
      if (cur && cur.status !== "idle") return;
      var c = sideColumnFor(i);
      renderSideCol(i, { status: "idle", model: c.model, label: c.label, text: "", error: "" });
    });
  }

  function setSideBusy(b) {
    chat.sideBusy = b;
    $("side-send").disabled = b;
    $("side-send").textContent = b ? "Sending..." : "Send to both";
  }

  function sideSend() {
    if (chat.sideBusy) return;
    var q = $("side-input").value.trim();
    if (!q) { chatNote("Type a question first.", "warn"); $("side-input").focus(); return; }
    var provider = chatProvider(), key = "";
    var ids = [$("side-model-a").value, $("side-model-b").value];
    if (provider === "openrouter") {
      if (!ids[0] && !ids[1]) { chatNote("Choose a model for at least one column.", "warn"); $("side-model-a").focus(); return; }
      key = readKey(keyStorage());
      if (!key) { promptForKey(); return; }
    }
    var msgs = [{ role: "user", content: q }], stream = $("chat-stream").checked;
    var cols = [0, 1].map(function (i) {
      var c = sideColumnFor(i);
      if (!c.model) return { model: "", label: "", req: null };
      return { model: c.model, label: c.label, req: buildChatRequest(provider, c.model, msgs, key, stream) };
    });
    setSideBusy(true);
    chatNote("Sending to both columns...");
    runCompare(chatFetch, cols, renderSideCol, { pageUrl: location.href }).then(function (res) {
      setSideBusy(false);
      var fails = res.filter(function (c) { return c.status === "error"; }).length;
      chatNote(fails === 0 ? "Both answers are in." : fails === 1 ? "One column failed; the other answer is shown." : "Both columns failed: see each column for the reason.", fails ? "warn" : "");
    });
  }

  // ----- "Ask this model" on the cards -----
  function askFromCard(btn) {
    var id = btn.getAttribute("data-ask"), name = btn.getAttribute("data-name") || id;
    if (!id) return;
    var listed = Array.prototype.some.call($("chat-model").options, function (o) { return o.value === id; });
    if (!listed) { chat.extra.push({ openrouter_id: id, model: name }); fillChatPickers(); }
    var note = "";
    if (chatProvider() === "local") {
      $("chat-provider-openrouter").checked = true;
      applyProvider();
      note = " Switched the provider to OpenRouter, because local mode only runs dolphin3.";
    }
    var t = askTarget(chatMode(), [$("side-model-a").value, $("side-model-b").value]), target;
    if (t.target === "single") {
      $("chat-model").value = id;
      renderModelNote();
      chatNote("Chat model set to " + name + "." + note + " Type your question below.", "ok");
      target = $("chat-input");
    } else {
      (t.index ? $("side-model-b") : $("side-model-a")).value = id;
      chat.side[t.index] = null;
      renderSideIdle();
      chatNote((t.index ? "Right" : "Left") + " column set to " + name + "." + note, "ok");
      target = $("side-input");
    }
    // Bring the chat panel to the top, then let focus scroll the input into view if it is still below the fold (phones).
    var panel = $("chat-main");
    if (panel.scrollIntoView) panel.scrollIntoView({ block: "start" });
    target.focus();
  }

  function initChat() {
    $("chat-provider-openrouter").addEventListener("change", applyProvider);
    $("chat-provider-local").addEventListener("change", applyProvider);
    $("chat-mode-single").addEventListener("change", applyMode);
    $("chat-mode-side").addEventListener("change", applyMode);
    $("chat-key-form").addEventListener("submit", function (e) { e.preventDefault(); saveKeyFromForm(); });
    $("chat-key-forget").addEventListener("click", forgetKeyClick);
    $("chat-key").addEventListener("input", function () { keyError(""); });
    $("chat-model").addEventListener("change", renderModelNote);
    $("side-model-a").addEventListener("change", function () { chat.side[0] = null; renderSideIdle(); });
    $("side-model-b").addEventListener("change", function () { chat.side[1] = null; renderSideIdle(); });
    $("chat-form").addEventListener("submit", function (e) { e.preventDefault(); chatSend(); });
    $("side-form").addEventListener("submit", function (e) { e.preventDefault(); sideSend(); });
    // Enter sends, Shift+Enter adds a line (and never while an input method is composing text).
    $("chat-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSend(); }
    });
    $("side-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sideSend(); }
    });
    $("chat-clear").addEventListener("click", function () {
      if (chat.busy) return;
      chat.entries = [];
      renderChatLog();
      chatNote("Conversation cleared.");
      $("chat-input").focus();
    });
    $("cards").addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest(".ask-btn") : null;
      if (b && !b.disabled) askFromCard(b);
      var c = e.target && e.target.closest ? e.target.closest(".compare-btn") : null;
      if (c) toggleCompare(c.getAttribute("data-compare"));
    });
    fillChatPickers();
    applyProvider();
    applyMode();
    renderKeyStatus();
    renderChatLog();
  }

  /** Settings from the page address (a shared link). Unknown or invalid ones are skipped and reported. */
  function settingsFromUrl() {
    var d = decodeSettings(location.search);
    if (Object.keys(d.settings).length) applySettings(d.settings);
    if (d.ignored.length) $("share-status").textContent = "This link had settings Model Scout could not read, so they were skipped: " + d.ignored.join(", ") + ".";
    else if (Object.keys(d.settings).length) $("share-status").textContent = "Settings loaded from the link.";
  }

  function init() {
    var form = $("profile");
    function edited(e) {
      var id = e && e.target && e.target.id;
      if (id && /^req-/.test(id)) { renderHelper(); return; } // the volume helper only fills the fields when asked
      if (id && /^sample-/.test(id)) { renderSample(); return; } // so does the sample counter
      state.touched = true;
      if (id !== "task-desc") dropLeverUndo();
      if (e && e.type === "input" && id !== "task-desc") markPreset("");
      render();
    }
    form.addEventListener("input", edited);
    form.addEventListener("change", edited);
    form.addEventListener("submit", function (e) { e.preventDefault(); render(); });
    $("suggest").addEventListener("click", applySuggestions);
    $("include-live").addEventListener("change", render);
    $("current-model").addEventListener("change", function () {
      renderSwitch();
      if (state.lastRes) renderMarket(state.lastRes, state.lastProfile);
    });
    $("preset-list").addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest(".preset") : null;
      if (b) usePreset(b.getAttribute("data-preset"));
    });
    $("req-apply").addEventListener("click", applyHelper);
    $("sample-apply").addEventListener("click", applySample);
    $("share-link").addEventListener("click", copyShareLink);
    $("cards-toggle").addEventListener("click", function () {
      state.showAllCards = !state.showAllCards;
      applyCardLimit();
      if (!state.showAllCards) $("cards-toggle").scrollIntoView({ block: "nearest" });
    });
    // A link to a card that is folded away opens every card first, so the jump lands.
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href^="#card-"]') : null;
      if (!a) return;
      var card = document.getElementById(a.getAttribute("href").slice(1));
      if (card && card.hidden) { state.showAllCards = true; applyCardLimit(); }
    });
    var map = $("value-map");
    function dot(e) { return e.target && e.target.closest ? e.target.closest("circle[data-id]") : null; }
    map.addEventListener("mouseover", function (e) { var d = dot(e); if (d) mapReadout(d.getAttribute("data-id")); });
    map.addEventListener("mouseleave", function () { mapReadout(null); });
    map.addEventListener("click", function (e) { var d = dot(e); if (d) openCard(d.getAttribute("data-id")); });
    map.addEventListener("keydown", mapKey);
    map.addEventListener("focus", function () {
      var order = mapOrder("score");
      if (!state.mapCursorId && order.length) state.mapCursorId = order[0];
      if (state.mapCursorId) mapCursor(state.mapCursorId);
    });
    map.addEventListener("blur", function () {
      Array.prototype.forEach.call(map.querySelectorAll("circle.is-cursor"), function (c) { c.classList.remove("is-cursor"); });
      mapReadout(null);
    });
    $("h2h-table").addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest(".h2h-remove") : null;
      if (b) toggleCompare(b.getAttribute("data-compare"));
    });
    $("h2h-ask").addEventListener("click", askPairSideBySide);
    function clearCompare() { state.compare = []; state.compareNote = ""; renderCompare(state.lastRes, state.lastProfile); }
    $("h2h-clear").addEventListener("click", clearCompare);
    $("compare-tray-clear").addEventListener("click", clearCompare);
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (state.lastRes && Math.abs($("value-map").clientWidth - (state.mapWidth || 0)) > 30) renderValueMap(state.lastRes, state.lastProfile);
      }, 150);
    });
    $("weights-edit").addEventListener("click", toggleWeightEdit);
    $("weights-reset").addEventListener("click", resetWeights);
    $("weights").addEventListener("input", function (e) {
      var k = e.target && e.target.getAttribute && e.target.getAttribute("data-factor");
      if (!k || !state.customWeights) return;
      state.customWeights[k] = Number(e.target.value);
      if (!normalizeWeights(state.customWeights)) { state.customWeights[k] = 1; e.target.value = "1"; } // never all zero
      state.touched = true;
      markPreset("");
      render();
    });
    $("whatif").addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest("[data-lever]") : null;
      if (b) applyLever(Number(b.getAttribute("data-lever")));
    });
    $("whatif-undo").addEventListener("click", undoLever);
    $("mw-include").addEventListener("click", function () {
      $("include-live").checked = !$("include-live").checked;
      render();
      $("mw-include").focus();
    });
    [["mw-fresh-more", "fresh"], ["mw-retire-more", "retire"]].forEach(function (b) {
      $(b[0]).addEventListener("click", function () {
        state.mwOpen[b[1]] = !state.mwOpen[b[1]];
        if (state.lastRes) renderMarket(state.lastRes, state.lastProfile);
      });
    });
    $("tips").addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest(".tip-try") : null;
      if (b) tryTip(b.getAttribute("data-tip-key"), b.getAttribute("data-tip-dir"));
    });
    $("memo-copy").addEventListener("click", copyMemo);
    $("memo-download").addEventListener("click", downloadMemo);
    renderPresets();
    renderHelper();
    settingsFromUrl();
    initChat();
    loadCatalog().then(function (cat) {
      state.catalog = cat;
      state.base = cat.models.slice();
      $("catalog-date").textContent = cat.catalog_date;
      $("stale-days").textContent = String(cat.stale_after_days || STALE_AFTER_DAYS);
      renderStatus();
      render();
      fillChatPickers();
      return loadLive().then(function () { renderStatus(); render(); fillChatPickers(); });
    }).catch(function (e) {
      $("data-status").setAttribute("data-state", "error");
      $("data-status").innerHTML = '<p class="verdict warn">Could not load the model catalog (' + esc(e.message) + "). Try serving the folder with python3 -m http.server.</p>";
      var head = $("top-pick");
      head.setAttribute("aria-busy", "false");
      head.classList.add("is-empty");
      head.innerHTML = '<p class="eyebrow">No ranking</p><h3>The model catalog did not load</h3><p>Rankings need the catalog. See the message at the top of the page.</p>';
      $("compare-body").innerHTML = '<tr class="empty-row"><td colspan="12">No catalog loaded.</td></tr>';
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(this);
