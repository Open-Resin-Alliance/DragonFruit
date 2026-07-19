'use client';

import React, { useCallback } from 'react';
import { CloudDownload, GitBranch } from 'lucide-react';
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
      {/* Release Channel */}
      <section
        className="rounded-lg border p-3"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        <div className="flex items-start gap-2.5">
          <span
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
            style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}
          >
            <GitBranch className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Release Channel
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Choose which update feed to check for new versions.
            </p>
          </div>
        </div>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleChannelSelect('stable')}
              className="flex-1 rounded-md border px-3 py-2 text-left transition-all duration-150"
              style={
                channel === 'stable'
                  ? {
                      borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 35%)',
                      background: 'color-mix(in srgb, var(--accent), var(--surface-0) 84%)',
                      boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent), transparent 76%) inset',
                    }
                  : {
                      borderColor: 'var(--border-subtle)',
                      background: 'var(--surface-1)',
                    }
              }
            >
              <div className="text-sm font-semibold" style={{ color: channel === 'stable' ? 'var(--accent)' : 'var(--text-strong)' }}>
                Stable
              </div>
              <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Production releases only. Recommended for most users.
              </div>
            </button>

            <button
              type="button"
              onClick={() => handleChannelSelect('dev')}
              className="flex-1 rounded-md border px-3 py-2 text-left transition-all duration-150"
              style={
                channel === 'dev'
                  ? {
                      borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)',
                      background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 84%)',
                      boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent-secondary), transparent 76%) inset',
                    }
                  : {
                      borderColor: 'var(--border-subtle)',
                      background: 'var(--surface-1)',
                    }
              }
            >
              <div className="text-sm font-semibold" style={{ color: channel === 'dev' ? 'var(--accent-secondary)' : 'var(--text-strong)' }}>
                Dev
              </div>
              <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Pre-release builds from the dev branch. May be unstable.
              </div>
            </button>
          </div>
        </div>
      </section>

      {/* Update Checker */}
      <section
        className="rounded-lg border p-3"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        <div className="flex items-start gap-2.5">
          <span
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
            style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}
          >
            <CloudDownload className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Updates
            </h3>
            <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Check for and install new versions of DragonFruit.
            </p>
          </div>
        </div>

        <div className="mt-2">
          <UpdateCheckerSection />
        </div>
      </section>
    </div>
  );
}
