import { Schema } from 'effect';

export const activityMediaSchema = Schema.Struct({
  id: Schema.Finite,
  player_id: Schema.Finite,
  activity_id: Schema.Finite,
  content_type: Schema.String,
});
