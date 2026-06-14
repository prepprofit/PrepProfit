import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

/** Mock sample rows — real data arrives with the Recipes module (Sprint 1/2). */
const recipes = [
  { name: 'Sourdough loaf', margin: '68%' },
  { name: 'Butter croissant', margin: '61%' },
  { name: 'Beef bourguignon', margin: '54%' },
  { name: 'Lemon tart', margin: '49%' },
  { name: 'Caesar salad', margin: '44%' },
] as const;

export function TopRecipes({ title }: { title: string }) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3.5">
        {recipes.map((recipe) => (
          <div
            key={recipe.name}
            className="flex items-center justify-between gap-2"
          >
            <span className="truncate text-sm text-foreground">
              {recipe.name}
            </span>
            <Badge variant="positive">{recipe.margin}</Badge>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
