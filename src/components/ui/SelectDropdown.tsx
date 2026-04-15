import React from 'react';
import { ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';

export type SelectDropdownProps<T extends string | number = string> = {
  label?: string;
  id?: string;
  title?: string;
  ariaLabel?: string;
  value: T;
  options: Array<{
    value: T;
    label: string;
    disabled?: boolean;
    icon?: React.ReactNode;
    rightContent?: React.ReactNode;
    tone?: 'default' | 'accent';
  }>;
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  selectClassName?: string;
  selectStyle?: React.CSSProperties;
  labelClassName?: string;
  labelStyle?: React.CSSProperties;
  endAdornment?: React.ReactNode;
  leadingDisplay?: React.ReactNode;
  selectedDisplay?: React.ReactNode;
  hideSelectedText?: boolean;
  selectedDisplayAlignment?: 'left' | 'center';
  selectedDisplayOffsetX?: number;
  menuClassName?: string;
  menuAlign?: 'left' | 'right';
  optionClassName?: string;
  onFocus?: React.FocusEventHandler<HTMLElement>;
  onBlur?: React.FocusEventHandler<HTMLElement>;
};

/**
 * Generic reusable dropdown component with consistent styling.
 * Features a custom chevron icon and clean design.
 */
export function SelectDropdown<T extends string | number = string>({
  label,
  id,
  title,
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  className = '',
  selectClassName = '',
  selectStyle,
  labelClassName = '',
  labelStyle,
  endAdornment,
  leadingDisplay,
  selectedDisplay,
  hideSelectedText = false,
  selectedDisplayAlignment = 'left',
  selectedDisplayOffsetX = 0,
  menuClassName = '',
  menuAlign = 'left',
  optionClassName = '',
  onFocus,
  onBlur,
}: SelectDropdownProps<T>) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = React.useState(false);
  const [isFocused, setIsFocused] = React.useState(false);
  const [hoveredOptionKey, setHoveredOptionKey] = React.useState<string | null>(null);
  const [menuPosition, setMenuPosition] = React.useState<{ top: number; left: number; minWidth: number; maxHeight: number; visibility: 'hidden' | 'visible' } | null>(null);

  const selectedOption = React.useMemo(
    () => options.find((option) => String(option.value) === String(value)) ?? null,
    [options, value],
  );

  const clearActiveFocus = React.useCallback(() => {
    if (typeof document === 'undefined') return;
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    triggerRef.current?.blur();
  }, []);

  React.useEffect(() => {
    if (!isOpen) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setIsOpen(false);
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onEscape);

    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onEscape);
    };
  }, [isOpen]);

  const updateMenuPosition = React.useCallback((measureMenu: boolean) => {
    const trigger = containerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 8;
    const gap = 6;

    const measuredMenuWidth = measureMenu && menuRef.current
      ? menuRef.current.offsetWidth
      : rect.width;
    const measuredMenuHeight = measureMenu && menuRef.current
      ? menuRef.current.offsetHeight
      : 0;

    let left = rect.left;
    if (menuAlign === 'right') {
      left = rect.right - measuredMenuWidth;
    }

    left = Math.max(margin, Math.min(left, viewportWidth - margin - measuredMenuWidth));

    const belowSpace = viewportHeight - (rect.bottom + gap) - margin;
    const aboveSpace = rect.top - gap - margin;
    const shouldOpenUpwards = measureMenu
      ? (belowSpace < Math.min(180, measuredMenuHeight) && aboveSpace > belowSpace)
      : false;

    let top = rect.bottom + gap;
    let maxHeight = Math.max(120, belowSpace);

    if (shouldOpenUpwards) {
      top = Math.max(margin, rect.top - measuredMenuHeight - gap);
      maxHeight = Math.max(120, aboveSpace);
    }

    setMenuPosition({
      top,
      left,
      minWidth: rect.width,
      maxHeight,
      visibility: measureMenu ? 'visible' : 'hidden',
    });
  }, [menuAlign]);

  React.useEffect(() => {
    if (!isOpen) {
      setHoveredOptionKey(null);
      setMenuPosition(null);
      return;
    }

    updateMenuPosition(false);

    const raf = window.requestAnimationFrame(() => {
      updateMenuPosition(true);
    });

    const onLayoutChange = () => {
      updateMenuPosition(true);
    };

    window.addEventListener('resize', onLayoutChange);
    window.addEventListener('scroll', onLayoutChange, true);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', onLayoutChange);
      window.removeEventListener('scroll', onLayoutChange, true);
    };
  }, [isOpen, updateMenuPosition]);

  const selectedLabel = selectedOption?.label ?? String(value);

  return (
    <label className={`space-y-1 block ${className}`}>
      {label && (
        <span className={`ui-label font-medium inline-flex items-center ${labelClassName}`} style={labelStyle}>
          {label}
        </span>
      )}
      <div
        ref={containerRef}
        className="relative"
        onFocusCapture={(event) => {
          if (isFocused) return;
          setIsFocused(true);
          onFocus?.(event);
        }}
        onBlurCapture={(event) => {
          const next = event.relatedTarget as Node | null;
          if (next && (event.currentTarget.contains(next) || menuRef.current?.contains(next))) return;
          setIsFocused(false);
          setIsOpen(false);
          onBlur?.(event);
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          id={id}
          title={title}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setIsOpen((prev) => !prev);
          }}
          onKeyDown={(event) => {
            if (disabled) return;
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
              event.preventDefault();
              setIsOpen(true);
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setIsOpen(false);
            }
          }}
          className={`ui-input rounded-[4px] relative w-full h-[36px] px-2.5 pr-10 leading-tight text-sm disabled:opacity-55 disabled:cursor-not-allowed inline-flex items-center text-left ${selectClassName}`}
          style={{
            ...selectStyle,
            ...(isOpen
              ? {
                  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 18%)',
                  boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent), transparent 72%) inset',
                }
              : undefined),
          }}
        >
          {leadingDisplay && !(hideSelectedText && selectedDisplay) && (
            <span className="mr-1.5 inline-flex shrink-0 items-center justify-center">
              {leadingDisplay}
            </span>
          )}

          <span
            className={`min-w-0 flex-1 truncate ${(hideSelectedText && selectedDisplay) ? 'text-transparent' : ''}`}
            style={hideSelectedText && selectedDisplay
              ? {
                  color: 'transparent',
                  WebkitTextFillColor: 'transparent',
                }
              : undefined}
          >
            {selectedLabel}
          </span>

          {selectedDisplay && hideSelectedText && (
            <span
              className={`pointer-events-none absolute top-1/2 inline-flex -translate-y-1/2 items-center ${selectedDisplayAlignment === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-2.5'}`}
              style={selectedDisplayOffsetX !== 0 ? { marginLeft: selectedDisplayOffsetX } : undefined}
            >
              {selectedDisplay}
            </span>
          )}

        {endAdornment && (
          <span className="pointer-events-none absolute right-8 top-1/2 inline-flex -translate-y-1/2 items-center justify-center">
            {endAdornment}
          </span>
        )}
        <ChevronDown
          className={`pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          style={{ color: disabled ? 'var(--text-muted)' : 'var(--text-muted)' }}
        />

        </button>

        {isOpen && !disabled && typeof document !== 'undefined' && createPortal(
          <div
            ref={menuRef}
            role="listbox"
            className={`fixed z-[9999] overflow-y-auto rounded-[4px] border shadow-xl custom-scrollbar ${menuClassName}`}
            style={{
              top: menuPosition?.top ?? 0,
              left: menuPosition?.left ?? 0,
              width: menuPosition?.minWidth,
              minWidth: menuPosition?.minWidth,
              maxHeight: menuPosition?.maxHeight,
              visibility: menuPosition?.visibility ?? 'hidden',
              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 82%)',
              background: 'color-mix(in srgb, var(--surface-0), black 6%)',
              backdropFilter: 'blur(6px) saturate(112%)',
              WebkitBackdropFilter: 'blur(6px) saturate(112%)',
              boxShadow: '0 14px 34px rgba(0, 0, 0, 0.46), 0 4px 12px rgba(0, 0, 0, 0.32)',
            }}
          >
            {options.map((option, index) => {
              const optionKey = String(option.value);
              const isSelected = optionKey === String(value);
              const isHovered = hoveredOptionKey === optionKey;
              const optionTone = option.tone ?? 'default';
              const isAccentTone = optionTone === 'accent';

              return (
                <button
                  key={optionKey}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  onMouseEnter={() => setHoveredOptionKey(optionKey)}
                  onMouseLeave={() => setHoveredOptionKey((prev) => (prev === optionKey ? null : prev))}
                  onClick={() => {
                    if (option.disabled) return;
                    onChange(option.value);
                    setIsOpen(false);
                    setIsFocused(false);
                    clearActiveFocus();
                    window.requestAnimationFrame(() => {
                      clearActiveFocus();
                    });
                  }}
                  className={`group w-full px-3 py-2 text-left text-sm transition-colors inline-flex items-center gap-2 border-b last:border-b-0 ${optionClassName}`}
                  style={
                    option.disabled
                      ? {
                          opacity: 0.55,
                          cursor: 'not-allowed',
                          borderBottomColor: 'var(--border-subtle)',
                        }
                      : {
                          borderBottomColor: index === options.length - 1 ? 'transparent' : 'color-mix(in srgb, var(--border-subtle), transparent 16%)',
                          background: isSelected
                            ? 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)'
                            : (isHovered
                              ? (isAccentTone
                                ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 92%)'
                                : 'color-mix(in srgb, var(--surface-2), transparent 18%)')
                              : 'transparent'),
                          color: isAccentTone
                            ? 'var(--accent-secondary)'
                            : ((isSelected || isHovered) ? 'var(--text-strong)' : 'var(--text-muted)'),
                        }
                  }
                >
                  {option.icon ? (
                    <span
                      className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center"
                      style={{
                        color: isAccentTone
                          ? 'var(--accent-secondary)'
                          : (isSelected
                            ? 'var(--accent)'
                            : (isHovered ? 'var(--text-strong)' : 'var(--text-muted)')),
                      }}
                    >
                      {option.icon}
                    </span>
                  ) : null}
                  <span className="truncate text-[0.95em]">
                    {option.label}
                  </span>
                  {option.rightContent ? (
                    <span className="ml-auto inline-flex shrink-0 items-center justify-end text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {option.rightContent}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
      </div>
    </label>
  );
}
