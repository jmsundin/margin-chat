export function getStandaloneNoteActivationEvent(
  isActive: boolean,
  isInteractiveTarget: boolean,
) {
  if (isActive) return null;
  return isInteractiveTarget ? "pointerdown" : "click";
}
