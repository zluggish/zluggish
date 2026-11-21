---
sidebar_position: 2
description: Load ghosts as bots that ride the world.
---

# Bots

Bots are ghosts that continue to ride, on all routes.

## Turn on bots

1. Set `bots.enabled` to `true` in `zluggish.config.ts`.
2. To make copies of each bot, set `bots.multiplier` to an integer from 1 to 100.
3. Start the server again.

A large multiplier can decrease the performance.

## Chat commands

| Command          | Result                                                           |
| ---------------- | ---------------------------------------------------------------- |
| `.group`         | Group the bots.                                                  |
| `.groupall`      | Group the bots and their copies.                                 |
| `.autogroup`     | Group the bots each time that you change roads.                  |
| `.autogroupall`  | Group the bots and their copies each time that you change roads. |
| `.stopautogroup` | Stop the automatic grouping.                                     |
| `.disperse`      | Put the bots at random positions.                                |

## Names and equipment

To set the names, nationalities and equipment of bots, make a file `bot.txt` in the `storage` folder.

If you have a catalogue from zwift-offline, keep it. Set `bots.ridersFile` to its path in `zluggish.config.ts`. The old Python catalogue helper is not included. A rider in the catalogue keeps the `weight_in_grams`, `height_in_millimeters`, `body_type` and `facial_hair_type` that you give; the fields you leave out are drawn at random. `body_type` sets the skin tone and build, so name it to give a rider a fixed look.

For random bots, see the [zoffline-bots repository](https://github.com/oldnapalm/zoffline-bots).
