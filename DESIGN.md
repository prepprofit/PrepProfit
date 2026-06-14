# PrepProfit Design System & UI Guidelines

This document contains strictly defined design specifications, exact color palettes, typography settings, and UI component guidelines for the **PrepProfit SaaS**.


## 1. Exact Color Palette & Mapping

A aplicação abandona cinzas comuns (`gray`, `zinc`, `neutral`) em favor da escala **Slate** para uma estética profissional, "fria/limpa" e escandinava. Uma escala customizada de **Emerald Green** (nomeada de `brand`) é usada rigorosamente para os lucros, destaques positivos e CTAs (como visto no botão principal e indicadores "+14%"). 

### CSS Variables (Adicione no `app/globals.css` - Tailwind v4)
```css
@theme {
  /* Fontes Customizadas */
  --font-sans: var(--font-sans), ui-sans-serif, system-ui, sans-serif;
  --font-display: var(--font-display), ui-sans-serif, system-ui, sans-serif;
  
  /* Sistema de Cores Primário (PrepProfit Emerald) */
  --color-brand-50: #effdf4;  /* Fundo sutil: Itens ativos do menu, fundo de badges claros */
  --color-brand-100: #d9fbe6; /* Hover states, avatares ou ícones em highlight */
  --color-brand-200: #b5f5d1;
  --color-brand-300: #7decb5;
  --color-brand-400: #3fda91; /* Ícones contrastantes e grafismos em fundos escuros */
  --color-brand-500: #1abf73; /* Progress bars, botão "View Income Statement" (fundo escuro) */
  --color-brand-600: #109b5a; /* COR PRIMÁRIA: Botão "Start 14-day free trial", Ícone principal, Textos ativos */
  --color-brand-700: #0f7a49; /* Hover para os botões primários */
  --color-brand-800: #10603d;
  --color-brand-900: #0e4f33;
}
```

### Onde aplicar as cores (Baseado fielmente na captura de ecrã/imagem):
1.  **Fundos (Backgrounds):**
    *   **Fundo da Aplicação Global:** `bg-slate-50` (`#f8fafc`). Note como a área em torno dos cartões de dashboard/sidebar tem uma cor contínua muito clara, não é 100% branca!
    *   **Cards e Painéis Principais:** `bg-white` (`#ffffff`) com linhas divisórias e bordas `border-slate-200` (`#e2e8f0`).
    *   **Cartões Escuros (ex: Monthly Profit Goal):** `bg-slate-900` (`#0f172a`), utilizando texto com `text-slate-300` a `text-white`.
2.  **Textos e Tipografia (Slate Scale):**
    *   Títulos proeminentes (ex: "Financial Overview") e Números-Chave (ex: "$24,500"): `text-slate-900`.
    *   Textos secundários e Descrições de itens de lista: `text-slate-500` a `text-slate-600`.
3.  **Indicadores de Crescimento / Badges:**
    *   Usar badge positiva com fundo verde bem claro e texto vibrante: `bg-brand-50 text-brand-600 font-semibold px-2 py-0.5 rounded-full`.
4.  **Sidebar (Menu Lateral):**
    *   Menu ativo (selecionado): Fundo e borda arredondada num *shape* branco (`bg-white shadow-sm border border-slate-200/60`), usando `text-brand-700` no ícone (`LayoutDashboard`) e fonte principal.
    *   Links Inativos do Menu Lateral: Textos com pouca opacidade, `text-slate-600 hover:bg-slate-100`.

## 2. Typography

A interface mistura uma fonte técnica moderna (Space Grotesk) para leitura de números em destaque/Headings, e uma sem-serifa hiper-legível (Inter) para componentes de UI repetitivos.

*   **Display Font**: **Space Grotesk** (Usado para `h1`, `h2`, Títulos dos Módulos, e Valores Financeiros gigantes).
*   **Body Font**: **Inter** (Usado para os itens da lista, descrições dos ingredientes, margens). Configurado como `--font-sans`.

### Setup do Next.js App Router (`app/layout.tsx`):
```tsx
import { Inter, Space_Grotesk } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const spaceGrotesk = Space_Grotesk({ subsets: ['latin'], variable: '--font-display' });

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable}`}>
       <body className="font-sans text-slate-900 bg-slate-50 antialiased" suppressHydrationWarning>
         {children}
       </body>
    </html>
  );
}
```

## 3. Guias de Componentização (Design Language System)

*   **Geometria da Interface (Bordas / Raios):**
    *   Botões grandes de Top Bar / Landing page: Formato "Pílula" (`rounded-full`).
    *   Cartões de Dashboard e painéis modulares: Use `rounded-xl` com uma borda delicada de marcação leve (`border border-slate-200`).
*   **Profundidade (Shadows):**
    *   A maior parte das cartas fixas apresenta pouca ou nenhuma sombra (`shadow-sm`).
    *   Elementos interativos que flutuam sobre a interface (como os toasts simulados e barras pop-ups laterais) ganham sombras elevadas tipo `shadow-xl border border-slate-200`.
*   **Gráficos e Ícones (Lucide React):**
    *   É expressamente recomendado o uso da biblioteca `lucide-react` para os pictos, espessura flexível no traço e estilo consistenre na visualização (Icons chave: `ChefHat`, `LayoutDashboard`, `BarChart3`, `CircleDollarSign`, `Calculator`, `TrendingUp`, `Package`, `Utensils`).

## 4. Assets e Marca

*   **O Logo da Empresa (PrepProfit):** O arquivo de logotipo gerado encontra-se em `public/logo_final.jpg`.
*   No Top Nav Menu, deve ser implementado no formato pequeno, ao lado do nome em Display text, aplicando `border-radius: 6px` (`rounded-md`), garantindo consistência SaaS premium.
