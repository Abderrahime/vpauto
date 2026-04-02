import React from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

interface Props {
  data: { date: string; price: number }[];
}

export default function PriceChart({ data }: Props) {
  const labels = data.map((d) => {
    try {
      return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short' }).format(new Date(d.date));
    } catch {
      return d.date;
    }
  });

  const prices = data.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);

  return (
    <Line
      height={100}
      data={{
        labels,
        datasets: [
          {
            data: prices,
            borderColor: '#003366',
            backgroundColor: 'rgba(0,51,102,0.08)',
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: '#f47920',
            fill: true,
            tension: 0.3,
          },
        ],
      }}
      options={{
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `${(ctx.raw as number).toLocaleString('fr-FR')} €`,
            },
          },
        },
        scales: {
          y: {
            min: Math.max(0, min - (max - min) * 0.2),
            ticks: {
              font: { size: 10 },
              callback: (v) => `${Number(v).toLocaleString('fr-FR')} €`,
            },
            grid: { color: '#f0f4ff' },
          },
          x: {
            ticks: { font: { size: 10 } },
            grid: { display: false },
          },
        },
      }}
    />
  );
}
