/** Scroll only the owning viewport; scrollIntoView also moves ancestor grids and sidebars. */
export function scrollWithin(container: HTMLElement | null, target: HTMLElement | null, axis: 'vertical' | 'horizontal', align: 'start' | 'center' = 'center', behavior: ScrollBehavior = 'instant') {
  if (!container || !target || !container.contains(target)) return;
  const box = container.getBoundingClientRect(), item = target.getBoundingClientRect();
  if (axis === 'vertical') {
    const scale = container.offsetHeight > 0 ? box.height / container.offsetHeight : 1;
    const offset = (item.top - box.top) / (scale || 1) - container.clientTop;
    container.scrollTo({ top: container.scrollTop + offset - (align === 'center' ? (container.clientHeight - item.height / (scale || 1)) / 2 : 0), behavior });
  } else {
    const scale = container.offsetWidth > 0 ? box.width / container.offsetWidth : 1;
    const offset = (item.left - box.left) / (scale || 1) - container.clientLeft;
    container.scrollTo({ left: container.scrollLeft + offset - (align === 'center' ? (container.clientWidth - item.width / (scale || 1)) / 2 : 0), behavior });
  }
}
