// lib/tree/item.js
// Tree-node wrappers for GitHub issues/PRs and label color parsing.

function hexToRgb(hex) {
  if (!hex || typeof hex !== "string") return null;
  const match = hex.match(/^#?([a-f\d]{6})$/i);
  if (!match) return null;
  const intVal = parseInt(match[1], 16);
  return {
    r: ((intVal >> 16) & 255) / 255,
    g: ((intVal >> 8) & 255) / 255,
    b: (intVal & 255) / 255,
  };
}

class IssueItem {
  constructor(issue) {
    this.issue = issue;
    this.children = [];
    this.parent = null;
  }
}

module.exports = { hexToRgb, IssueItem };
