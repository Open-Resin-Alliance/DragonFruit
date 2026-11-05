/**
 * The compatibility page, driven like the app's own Printer Library: a
 * manufacturer rail and a search field on the left, the presets grouped by family
 * on the right.
 *
 * The rail is in the markup and its buttons are anchors, so without this script
 * they jump to the manufacturer's section instead of filtering. The search field
 * is the one control that cannot work without it, so it is hidden until here.
 * Searching ignores the manufacturer, the same way the app does, so a name always
 * finds its machine.
 */
export function initMachineLibrary(): void {
  const search = document.querySelector<HTMLElement>('[data-machine-search]');
  const input = document.querySelector<HTMLInputElement>('[data-machine-query]');
  const empty = document.querySelector<HTMLElement>('[data-machine-empty]');
  const makers = [...document.querySelectorAll<HTMLAnchorElement>('[data-maker]')];
  if (!search || !input || !empty || makers.length === 0) return;

  const groups = [...document.querySelectorAll<HTMLElement>('[data-group]')];
  let manufacturer = '';

  const apply = (): void => {
    const query = input.value.trim().toLowerCase();
    const searching = query !== '';
    let shownTotal = 0;

    for (const group of groups) {
      const groupManufacturer = group.dataset.manufacturer ?? '';
      let groupShown = 0;

      for (const family of group.querySelectorAll<HTMLElement>('[data-family]')) {
        let shown = 0;

        for (const card of family.querySelectorAll<HTMLElement>('[data-machine-row]')) {
          const manufacturerMatch = searching || manufacturer === '' || groupManufacturer === manufacturer;
          const searchMatch = !searching || (card.dataset.search ?? '').includes(query);
          const hit = manufacturerMatch && searchMatch;

          card.hidden = !hit;
          if (hit) shown += 1;
        }

        family.hidden = shown === 0;
        groupShown += shown;
      }

      group.hidden = groupShown === 0;
      shownTotal += groupShown;
    }

    empty.hidden = shownTotal > 0;
  };

  for (const maker of makers) {
    maker.addEventListener('click', (event) => {
      event.preventDefault();
      manufacturer = maker.dataset.manufacturer ?? '';

      for (const other of makers) {
        if (other === maker) other.setAttribute('aria-current', 'true');
        else other.removeAttribute('aria-current');
      }

      apply();
    });
  }

  input.addEventListener('input', apply);
  search.hidden = false;
}
