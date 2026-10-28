'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Each project is a folder holding project.json, REA scan Evidence and
// whatever the agent writes. The folder doubles as the agent's workspace.
class ProjectStore {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  dir(id) {
    if (!/^[\w-]+$/.test(id)) throw new Error('Unknown project.');
    return path.join(this.root, id);
  }

  list() {
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.read(entry.name))
      .filter(Boolean)
      .map(({ id, name, createdAt, updatedAt, targets }) => ({ id, name, createdAt, updatedAt, targetCount: targets.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  read(id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir(id), 'project.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  get(id) {
    const project = this.read(id);
    if (!project) throw new Error('That project no longer exists.');
    // A run that was in progress when Unbox quit can never finish.
    for (const turn of project.turns) {
      if (turn.status === 'running') {
        turn.status = 'stopped';
        turn.error = 'Unbox closed before this run finished.';
      }
    }
    return project;
  }

  save(project) {
    project.updatedAt = new Date().toISOString();
    const file = path.join(this.dir(project.id), 'project.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(project, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    return project;
  }

  create(name) {
    const clean = String(name || '').trim().slice(0, 80) || 'Untitled project';
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    fs.mkdirSync(this.dir(id), { recursive: true });
    const now = new Date().toISOString();
    return this.save({ id, name: clean, createdAt: now, updatedAt: now, targets: [], turns: [] });
  }

  rename(id, name) {
    const project = this.get(id);
    project.name = String(name || '').trim().slice(0, 80) || project.name;
    return this.save(project);
  }

  addTargets(id, paths) {
    const project = this.get(id);
    for (const targetPath of paths) {
      if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath) || !fs.existsSync(targetPath)) continue;
      if (project.targets.some((target) => target.path === targetPath)) continue;
      const stat = fs.statSync(targetPath);
      project.targets.push({
        path: targetPath,
        name: path.basename(targetPath),
        isDirectory: stat.isDirectory(),
        size: stat.isDirectory() ? null : stat.size,
        scan: null,
      });
    }
    return this.save(project);
  }

  removeTarget(id, targetPath) {
    const project = this.get(id);
    project.targets = project.targets.filter((target) => target.path !== targetPath);
    return this.save(project);
  }

  hasTarget(id, targetPath) {
    return this.get(id).targets.some((target) => target.path === targetPath);
  }

  update(id, mutate) {
    const project = this.get(id);
    mutate(project);
    return this.save(project);
  }
}

module.exports = { ProjectStore };
