'use client';

import React, { useCallback } from 'react';
import { AlertTriangle, FlaskConical, Settings, ShieldCheck } from 'lucide-react';
import { useIsLinux } from '@/hooks/usePlatform';
import { UpdateCheckerSection } from '@/features/updater/UpdateCheckerSection';
import { setUpdateChannel } from '@/features/updater/updateBridge';
import type { UpdateChannel } from '@/features/updater/updateBridge';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
const activeChannelStyle: React.CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)',
  color: 'var(--text-strong)',
};

interface UpdatesSettingsTabProps {
  channel: UpdateChannel;
  onChannelChange: (channel: UpdateChannel) => void;
}

export function UpdatesSettingsTab({
  channel,
  onChannelChange,
}: UpdatesSettingsTabProps) {
  const isLinux = useIsLinux();
  const [showChannelSettings, setShowChannelSettings] = React.useState(false);
  const [pendingChannel, setPendingChannel] = React.useState<UpdateChannel>(channel);

  const commitChannel = useCallback(
    (newChannel: UpdateChannel) => {
      onChannelChange(newChannel);
      void setUpdateChannel(newChannel);
    },
    [onChannelChange],
  );
  const handleChannelSelect = useCallback(
    (newChannel: UpdateChannel) => {
      setPendingChannel(newChannel);
    },
    [],
  );

  const handleApplyChannel = useCallback(() => {
    if (pendingChannel === channel) {
      setShowChannelSettings(false);
      return;
    }
    commitChannel(pendingChannel);
    setShowChannelSettings(false);
  }, [pendingChannel, channel, commitChannel]);

  React.useEffect(() => {
    if (showChannelSettings) setPendingChannel(channel);
  }, [showChannelSettings, channel]);

  const isPendingDevSwitch = pendingChannel === 'dev' && channel !== 'dev';

  return (
    <div className="flex h-full min-h-0 flex-col space-y-3">
      <section
        className="relative flex min-h-0 flex-1 flex-col rounded-lg border p-3"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        {!isLinux && (
          <button
            type="button"
            onClick={() => setShowChannelSettings(true)}
            className="absolute right-3 top-3 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors hover:brightness-110"
            style={{ borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)', background: 'color-mix(in srgb, var(--accent), var(--surface-1) 85%)', color: 'var(--accent)' }}
            aria-label="Release channel settings"
            title="Release channel settings"
          >
            <Settings className="h-4 w-4" />
          </button>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <UpdateCheckerSection className="flex min-h-0 flex-1 flex-col" />
        </div>
      </section>
      <StructuredDialogModal
        open={showChannelSettings}
        ariaLabel="Release channel settings"
        title="Release Channel"
        subtitle="Choose which update feed to check for new versions."
        icon={<Settings className="h-5 w-5" style={{ color: 'var(--accent)' }} />}
        iconTone="neutral"
        onClose={() => setShowChannelSettings(false)}
        onBackdropClick={() => setShowChannelSettings(false)}
        actions={
          <>
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={() => setShowChannelSettings(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={
                pendingChannel === channel
                  ? { borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)', opacity: 0.6 as unknown as string }
                  : isPendingDevSwitch
                    ? { borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)', background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)', color: '#f59e0b' }
                    : { borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)', background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)', color: 'var(--accent)' }
              }
              onClick={handleApplyChannel}
              disabled={pendingChannel === channel}
            >
              {isPendingDevSwitch ? (
                <>
                  <FlaskConical className="w-3.5 h-3.5" />
                  Switch to Previews
                </>
              ) : (
                'Apply'
              )}
            </button>
          </>
        }
      >
        <div className="grid gap-2.5" role="tablist" aria-label="Release channel">
          <button
            type="button"
            role="tab"
            aria-selected={pendingChannel === 'stable'}
            onClick={() => handleChannelSelect('stable')}
            className="ui-button ui-button-secondary flex flex-col items-center justify-center gap-1.5 px-2 py-6 text-center min-h-[64px]"
            style={pendingChannel === 'stable' ? activeChannelStyle : undefined}
          >
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold leading-none">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
              Stable Builds
            </span>
            <span className="text-xs font-normal leading-tight" style={{ color: 'var(--text-muted)' }}>
              Recommended · Production
            </span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={pendingChannel === 'dev'}
            onClick={() => handleChannelSelect('dev')}
            className="ui-button ui-button-secondary flex flex-col items-center justify-center gap-1.5 px-2 py-6 text-center min-h-[64px]"
            style={pendingChannel === 'dev' ? activeChannelStyle : undefined}
          >
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold leading-none">
              <FlaskConical className="h-3.5 w-3.5 shrink-0" />
              Development Previews
            </span>
            <span className="text-xs font-normal leading-tight" style={{ color: 'var(--text-muted)' }}>
              Early access · May be unstable
            </span>
          </button>
        </div>
        {isPendingDevSwitch && (
          <div className="mt-3 rounded-md border px-3 py-2.5 flex gap-2.5" style={{ borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 40%)', background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 90%)' }}>
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" style={{ color: '#f59e0b' }} />
            <div className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>Development Previews</span> are built from the <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>dev</span> branch for early testing. Expect bugs and breaking changes — switch back to Stable Builds at any time.
            </div>
          </div>
        )}
      </StructuredDialogModal>
    </div>
  );
}
