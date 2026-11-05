/**
 * The compatibility page, driven like the app's own Printer Library: a
 * manufacturer rail and a search field on the left, the presets grouped by family
 * on the right.
 *
 * The rail is hidden in the markup and only revealed here, because a filter that
 * does nothing is worse than no filter. Searching ignores the manufacturer, the
 * same way the app does, so a name always finds its machine.
 */
export function initMachineLibrary(): void {
  const library = document.querySelector<HTMLElement>('[data-library]');
  const rail = document.querySelector<HTMLElement>('[data-machine-rail]');
  const input = document.querySelector<HTMLInputElement>('[data-machine-query]');
  const empty = document.querySelector<HTMLElement>('[data-machine-empty]');
  const makers = [...document.querySelectorAll<HTMLButtonElement>('[data-maker]')];
  if (!library || !rail || !input || !empty || makers.length === 0) return;

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
    maker.addEventListener('click', () => {
      manufacturer = maker.dataset.manufacturer ?? '';
      for (const other of makers) other.setAttribute('aria-pressed', String(other === maker));
      apply();
    });
  }

  input.addEventListener('input', apply);

  rail.hidden = false;
  library.setAttribute('data-ready', '');
}
