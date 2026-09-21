// ItemFactory.js
import IssueItem from "./IssueItem.js";
import PullRequestItem from "./PullRequestItem.js";

/**
 * Builds list of IssueItem or PullRequestItem instances from raw GitHub data.
 * @param {Array<Object>} rawItems
 * @param {'issue'|'pull'} type
 * @param {Function} fetchComments
 * @param {Function} fetchReviewComments
 * @returns {Promise<Array<BaseItem>>}
 */
export async function buildItems(
  rawItems,
  type,
  fetchComments,
  fetchReviewComments,
) {
  const ItemClass = type === "issue" ? IssueItem : PullRequestItem;

  const items = [];
  for (const raw of rawItems) {
    const item = new ItemClass(raw);
    if (type === "issue") {
      await item.buildChildren(fetchComments);
    } else {
      await item.buildChildren(fetchComments, fetchReviewComments);
    }
    items.push(item);
  }
  return items;
}
