// PullRequestItem.js
import BaseItem from './BaseItem.js'

export default class PullRequestItem extends BaseItem {
  constructor(raw) {
    super(raw)
    // PR-specific fields
    this.draft = raw.draft || false
    this.mergedAt = raw.merged_at ? new Date(raw.merged_at) : null
    this.reviewCount = raw.review_comments || 0
    this.commentCount = raw.comments || 0
  }

  /**
   * Build children for a pull request: shared + merge/close + comments
   * @param {Function} fetchComments  fn(issueNumber, expectedCount)
   * @param {Function} fetchReviewComments  fn(pullNumber, expectedCount)
   */
  async buildChildren(fetchComments, fetchReviewComments) {
    // 1) common metadata
    const nodes = await this.buildCommonChildren()

    // 2) Merged vs closed
    if (this.mergedAt) {
      nodes.push(this._meta(
        'Merged',
        'issue_closed',
        this.mergedAt.toLocaleString()
      ))
    }
    else if (this.state === 'closed' && this.raw.closed_at) {
      nodes.push(this._meta(
        'PR Closed',
        'pr_closed',
        new Date(this.raw.closed_at).toLocaleString()
      ))
    }

    // 3) Comments group (issue + review)
    const issueComments = this.commentCount > 0
      ? await fetchComments(this.number, this.commentCount)
      : []
    const reviewComments = this.reviewCount > 0
      ? await fetchReviewComments(this.number, this.reviewCount)
      : []

    const allComments = [...issueComments, ...reviewComments]
    if (allComments.length) {
      const group = this._meta(
        `Comments (${allComments.length})`,
        'comments'
      )
      for (const c of allComments) {
        const date = new Date(c.created_at)
        const firstLine = c.body.split(/\r?\n/).find(l => l.trim()) || ''
        const item = this._meta(
          `${c.user.login} on ${date.toLocaleDateString(undefined, {month:'short', day:'numeric'})}`,
          'comment',
          firstLine,
          null,
          c.html_url
        )
        item.parent = group
        group.children.push(item)
      }
      group.parent = this
      nodes.push(group)
    }

    // Attach back-references
    for (const node of nodes) {
      node.parent = this
    }
    this.children = nodes
    return nodes
  }
}