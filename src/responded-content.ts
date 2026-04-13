export function clearRespondedContentIfCurrent(
  respondedContent: Map<string, string>,
  blipId: string,
  expectedContent: string,
): boolean {
  if (respondedContent.get(blipId) !== expectedContent) {
    return false;
  }

  respondedContent.delete(blipId);
  return true;
}
