import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { TopRecipe } from '@/lib/calculations/dashboard';
import { trafficLight } from '@/lib/calculations/margin';

const LIGHT_VARIANT = {
  green: 'positive',
  yellow: 'warning',
  red: 'negative',
} as const;

export function TopRecipes({
  title,
  recipes,
  emptyLabel,
}: {
  title: string;
  recipes: TopRecipe[];
  emptyLabel: string;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3.5">
        {recipes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          recipes.map((recipe) => (
            <div
              key={recipe.id}
              className="flex items-center justify-between gap-2"
            >
              <span className="truncate text-sm text-foreground">
                {recipe.name}
              </span>
              <Badge variant={LIGHT_VARIANT[trafficLight(recipe.marginPercent)]}>
                {recipe.marginPercent}%
              </Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
