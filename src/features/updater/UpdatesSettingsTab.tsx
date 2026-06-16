'use client';

import React, { useCallback } from 'react';
import { GitBranch } from 'lucide-react';
import { UpdateCheckerSection } from '@/features/updater/UpdateCheckerSection';
import { setUpdateChannel } from '@/features/updater/updateBridge';
import type { UpdateChannel } from '@/features/updater/updateBridge';

interface UpdatesSettingsTabProps {
  channel: UpdateChannel;
  onChannelChange: (channel: UpdateChannel) => void;
}

export function UpdatesSettingsTab({
  channel,
  onChannelChange,
}: UpdatesSettingsTabProps) {
  const handleChannelSelect = useCallback(
    (newChannel: UpdateChannel) => {
      onChannelChange(newChannel);
      void setUpdateChannel(newChannel);
    },
    [onChannelChange],
  );

  return (
    <div className="space-y-3">
      {/* Release channel selector */}
      <div
        className="rounded-lg border p-3"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'var(--surface-1)',
        }}
      >
        <div className="flex items-center gap-2 mb-2.5">
          <span
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-2)',
            }}
          >
            <GitBranch className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
          </span>
          <div>
            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Release Channel
            </div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Choose which update feed to check
            </div>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleChannelSelect('stable')}
            className="flex-1 rounded-lg border px-3 py-2 text-left transition-all duration-150"
            style={
              channel === 'stable'
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 35%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-0) 84%)',
                    boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent), transparent 76%) inset',
                  }
                : {
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-2)',
                  }
            }
          >
            <div className="text-sm font-semibold" style={{ color: channel === 'stable' ? 'var(--accent)' : 'var(--text-strong)' }}>
              Stable
            </div>
            <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Production releases only. Recommended for most users.
            </div>
          </button>

          <button
            type="button"
            onClick={() => handleChannelSelect('dev')}
            className="flex-1 rounded-lg border px-3 py-2 text-left transition-all duration-150"
            style={
              channel === 'dev'
                ? {
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 84%)',
                    boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent-secondary), transparent 76%) inset',
                  }
                : {
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-2)',
                  }
            }
          >
            <div className="text-sm font-semibold" style={{ color: channel === 'dev' ? 'var(--accent-secondary)' : 'var(--text-strong)' }}>
              Dev
            </div>
            <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Pre-release builds from the dev branch. May be unstable.
            </div>
          </button>
        </div>
      </div>

      {/* Update checker */}
      <UpdateCheckerSection />
    </div>
  );
}
