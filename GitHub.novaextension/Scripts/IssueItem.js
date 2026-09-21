// IssueItem.js
import BaseItem from "./BaseItem.js";

export default class IssueItem extends BaseItem {
  constructor(raw) {
    super(raw);
    // Issue-specific placeholder for comment count
    this.commentCount = raw.comments || 0;
  }

  /**
   * Build children for an issue: shared + closed timestamp + comments
   * @param {Function} fetchComments  function(issueNumber, expectedCount)
   */
  async buildChildren(fetchComments) {
    // 1) common metadata
    const nodes = await this.buildCommonChildren();

    // 2) Closed timestamp for issues
    if (this.state === "closed" && this.raw.closed_at) {
      nodes.push(
        this._meta(
          "Closed",
          "issue_closed",
          new Date(this.raw.closed_at).toLocaleString(),
        ),
      );
    }

    // 3) Comments group
    if (this.commentCount > 0) {
      const comments = await fetchComments(this.number, this.commentCount);
      const group = this._meta(`Comments (${comments.length})`, "comments");
      for (const c of comments) {
        const date = new Date(c.created_at);
        const firstLine = c.body.split(/\r?\n/).find((l) => l.trim()) || "";
        const item = this._meta(
          `${c.user.login} on ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
          "comment",
          firstLine,
          null,
          c.html_url,
        );
        item.parent = group;
        group.children.push(item);
      }
      group.parent = this;
      nodes.push(group);
    }

    // Attach back-references
    for (const node of nodes) {
      node.parent = this;
    }
    this.children = nodes;
    return nodes;
  }
}
