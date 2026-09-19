export function getStandaloneNoteActivationEvent(
  isActive: boolean,
  isInteractiveTarget: boolean,
) {
  if (isActive || isInteractiveTarget) return null;
  return "click";
}
