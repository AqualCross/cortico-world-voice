export function eventAt(events, seconds) {
  let low = 0, high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid].milliseconds <= seconds * 1000) low = mid + 1;
    else high = mid;
  }
  const event = events[low - 1];
  return event?.type === 'event' ? event : null;
}

export function followScore(sheet, tune, audio, { highlightNotes = false } = {}) {
  const events = tune.setTiming(0, 0), svg = sheet.querySelector('svg');
  const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  cursor.setAttribute('class', 'am-playhead');
  cursor.setAttribute('aria-hidden', 'true');
  cursor.style.display = 'none';
  svg.append(cursor);
  let previous = null, highlighted = [];
  return {
    update(active) {
      const event = active && !audio.ended ? eventAt(events, audio.currentTime) : null;
      if (event === previous) return;
      previous = event;
      for (const node of highlighted) node.classList.remove('abcjs-note_selected');
      highlighted = [];
      cursor.style.display = event?.left != null ? '' : 'none';
      if (event?.left == null) return;
      cursor.setAttribute('x', event.left - 3);
      cursor.setAttribute('y', event.top);
      cursor.setAttribute('width', Math.max(12, event.width + 6));
      cursor.setAttribute('height', event.height);
      if (highlightNotes) {
        for (const group of event.elements) for (const node of group) {
          node.classList.add('abcjs-note_selected'); highlighted.push(node);
        }
      }
    },
  };
}
