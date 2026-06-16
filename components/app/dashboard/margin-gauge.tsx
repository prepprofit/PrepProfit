'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
} from 'recharts';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/** Respects the OS "reduce motion" setting — disables Recharts' entry animation. */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * Radial gauge for the org's average recipe margin — the dashboard's headline
 * circular KPI (the "progress ring" in the reference). A single accent arc over
 * a muted track, with the value read out in the centre. The percentage is
 * clamped to 0–100 for the arc only; the centre label shows the true figure, and
 * `null` (no priced recipes) renders an empty track with a "—" readout.
 */
export function MarginGauge({
  /** Average margin %, or null when nothing is priced yet. */
  value,
  /** Context line under the gauge, e.g. how many recipes are priced. */
  caption,
}: {
  value: number | null;
  caption?: string;
}) {
  const t = useTranslations('dashboard.marginGauge');
  const reducedMotion = usePrefersReducedMotion();

  const arc = value == null ? 0 : Math.max(0, Math.min(100, value));
  const data = [{ name: 'margin', value: arc }];

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <div className="relative flex-1">
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart
                data={data}
                startAngle={220}
                endAngle={-40}
                innerRadius="70%"
                outerRadius="100%"
                barSize={16}
              >
                <defs>
                  <linearGradient id="fill-gauge" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="var(--color-accent-400)" />
                    <stop offset="100%" stopColor="var(--color-accent-600)" />
                  </linearGradient>
                </defs>
                <PolarAngleAxis
                  type="number"
                  domain={[0, 100]}
                  angleAxisId={0}
                  tick={false}
                />
                <RadialBar
                  dataKey="value"
                  angleAxisId={0}
                  cornerRadius={999}
                  fill="url(#fill-gauge)"
                  background={{ fill: 'var(--color-surface-2)' }}
                  isAnimationActive={!reducedMotion}
                />
              </RadialBarChart>
            </ResponsiveContainer>
          </div>

          {/* Centre readout — overlaid because the gauge opens at the bottom. */}
          <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 flex-col items-center">
            <span className="font-display text-4xl font-semibold tracking-tight tabular-nums text-foreground">
              {value == null ? '—' : `${value}%`}
            </span>
            <span className="text-xs text-muted-foreground">{t('center')}</span>
          </div>
        </div>

        {value == null ? (
          <p className="text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : caption ? (
          <p className="truncate text-center text-xs text-muted-foreground">
            {caption}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
