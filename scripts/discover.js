#!/usr/bin/env node
// What a Vercel build of this repository can see of the commit it ships --
// OKF-TOGAF#219, piece 4 of 568-CC, on the owner's lines "For piece 4: the gate
// may also read the commit's own id and the build's copy of its history, with
// no network call and no other variable; ..." and "The probe targets are
// superdtf-0882/okf-probe-inside with its Vercel project okf-probe, and
// superdtf-0882/okf-probe-outside; they hold nothing real, and the probe may
// write to them -- David Facer 10/20/2026".
//
// It reads one variable by name, the commit's id, and runs git on the build's
// own checkout. It makes no network call, lists no environment and prints no
// commit message. It writes public/discovery.json, which the deploy serves.
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const git = (...args) => {
  try { return { ok: true, out: String(execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"] })).trim() }; }
  catch (e) { return { ok: false, out: String((e.stderr || e.message || "")).trim().split("\n")[0].slice(0, 200) }; }
};

const varSha = process.env.VERCEL_GIT_COMMIT_SHA || null;
const head = git("rev-parse", "HEAD");
const out = {
  measured: new Date().toISOString(),
  gitDirectory: fs.existsSync(path.join(process.cwd(), ".git")),
  head: head.ok ? head.out : null,
  headError: head.ok ? null : head.out,
  variableSha: varSha,
  sameCommit: head.ok && varSha ? head.out === varSha : null,
  tree: (() => { const r = git("rev-parse", "HEAD^{tree}"); return r.ok ? r.out : null; })(),
  shallow: (() => { const r = git("rev-parse", "--is-shallow-repository"); return r.ok ? r.out : null; })(),
  depth: (() => { const r = git("rev-list", "--count", "HEAD"); return r.ok ? Number(r.out) : null; })(),
  parent: (() => { const r = git("rev-parse", "HEAD~1"); return r.ok ? r.out : null; })(),
  changedFiles: (() => { const r = git("diff", "--name-only", "HEAD~1", "HEAD"); return r.ok ? r.out.split("\n").filter(Boolean) : null; })(),
  changedError: (() => { const r = git("diff", "--name-only", "HEAD~1", "HEAD"); return r.ok ? null : r.out; })(),
};
fs.mkdirSync(path.join(process.cwd(), "public"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), "public", "discovery.json"), JSON.stringify(out, null, 2) + "\n");
fs.writeFileSync(path.join(process.cwd(), "public", "index.html"), "<!doctype html><title>okf-probe</title><p>Throwaway target for the authority probe. Nothing real here.</p>\n");
console.log("discovery written");
