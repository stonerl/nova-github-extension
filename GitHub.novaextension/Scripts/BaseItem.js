// BaseItem.js
// Shared base class for IssueItem and PullRequestItem
export default class BaseItem {
  /**
   * @param {Object} raw The raw GitHub API object (issue or PR)
   */
  constructor(raw) {
    this.raw = raw
    this.id = raw.id
    this.number = raw.number
    this.title = raw.title
    this.state = raw.state
    this.children = []
    this.parent = null
  }

  /**
   * Build shared child nodes: timestamps, author, assignees, milestone, labels.
   * Returns an array of metadata BaseItem nodes.
   */
  async buildCommonChildren() {
    const nodes = []

    // Created timestamp
    if (this.raw.created_at) {
      nodes.push(this._meta(
        'Created',
        'issue_created',
        new Date(this.raw.created_at).toLocaleString()
      ))
    }

    // Updated timestamp
    if (
      this.raw.updated_at &&
      this.raw.updated_at !== this.raw.created_at
    ) {
      nodes.push(this._meta(
        'Updated',
        'issue_updated',
        new Date(this.raw.updated_at).toLocaleString()
      ))
    }

    // State reason for closed items
    if (
      this.state === 'closed' &&
      this.raw.state_reason
    ) {
      const textMap = {
        completed:   'Completed',
        not_planned: 'Not Planned',
        duplicate:   'Duplicate',
        reopened:    'Reopened',
      }
      const iconMap = {
        completed:   'issue_completed',
        not_planned: 'issue_not_planned',
        duplicate:   'issue_not_planned',
        reopened:    'issue_reopened',
      }
      const reason = this.raw.state_reason
      nodes.push(this._meta(
        textMap[reason] || reason,
        iconMap[reason]
      ))
    }

    // Author
    if (this.raw.user?.login) {
      nodes.push(this._meta(
        'Author',
        'author',
        this.raw.user.login
      ))
    }

    // Assignees
    const assignees = this.raw.assignees ?? (
      this.raw.assignee ? [this.raw.assignee] : []
    )
    for (const a of assignees) {
      nodes.push(this._meta(
        'Assignee',
        'assignee',
        a.login
      ))
    }

    // Milestone
    if (this.raw.milestone?.title) {
      nodes.push(this._meta(
        'Milestone',
        null,
        this.raw.milestone.title
      ))
    }

    // Labels
    for (const lbl of this.raw.labels || []) {
      nodes.push(this._meta(
        lbl.name,
        null,
        null,
        lbl.color
      ))
    }

    // Attach back-references
    for (const node of nodes) {
      node.parent = this
    }

    return nodes
  }

  /**
   * Helper to create a metadata node as a BaseItem clone
   */
  _meta(title, image, body = null, hexColor = null, url = null) {
    const node = Object.assign(
      new BaseItem({ id: `${this.id}-${title}`, title }),
      {
        issue: { title, image, body, url },
        children: [],
        parent: null,
        contextValue: image === 'comment' ? 'comment' : undefined,
        color: hexColor ? this._hexToRgb(hexColor) : undefined,
      }
    )
    return node
  }

  /**
   * Convert hex string to RGB color object
   */
  _hexToRgb(hex) {
    const intVal = parseInt(hex.replace('#',''), 16)
    return {
      r: ((intVal >> 16) & 255) / 255,
      g: ((intVal >> 8 ) & 255) / 255,
      b: ( intVal        & 255) / 255,
    }
  }
}