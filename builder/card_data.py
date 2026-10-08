"""MYTHOS v1 — card data extras: provisional Mothman stats + 2 starter decks.

Mothman (008): the spreadsheet still lists TBD stats/rules (stale row from
before art was finalized). v1 invents simple provisional stats so the card is
playable; Joshua's retune of 002-007 may change these.
"""

MOTHMAN = {
    "id": 8,
    "cost": 4,
    "control": 2,
    "sanity": 5,
    "rules": "Enter: draw a card (night reconnaissance).",
    "flavor": "\u201cThe night shift never ends.\u201d",
    "provisional": True,
}

# 45 cards each. Constraints enforced by build.py:
# >=1 character, <=3 copies per name, <=1 copy per ritual.
DECKS = {
    "cult": {
        "name": "Cult of the Worshiper",
        "desc": "Ritual control — burn out your team, then take over reality.",
        "cards": (
            [1] * 3 + [7] * 2 + [53] * 2 + [54] * 2 + [51] * 2 +      # characters (11)
            [9] * 3 + [11] * 3 + [12] * 2 + [15] * 2 + [16] * 2 +
            [19] * 2 + [21] * 2 + [22] + [27] + [35] +                 # abominations (19)
            [39, 40, 41] +                                            # rituals (3)
            [43] * 2 + [44] +                                         # locations (3)
            [45] * 2 + [46] * 2 +                                     # actions (4)
            [47] * 2 + [48] +                                         # traps (3)
            [49] +                                                    # artifact (1)
            [50]                                                      # effect (1)
        ),
    },
    "board": {
        "name": "The Board's Hostile Bid",
        "desc": "Hostile aggro — flood the board and break their mind.",
        "cards": (
            [2] * 2 + [3] * 2 + [5] * 2 + [4] * 2 + [52] * 2 + [8] + [6] +  # characters (12)
            [13] * 3 + [18] * 3 + [17] * 2 + [14] * 2 + [10] * 2 +
            [24] * 2 + [30] + [31] + [58] + [57] +                     # abominations (18)
            [42, 55, 56] +                                            # rituals (3)
            [43] + [44] * 2 +                                         # locations (3)
            [59] * 2 + [46] +                                         # actions (3)
            [47] * 2 + [48] * 2 +                                     # traps (4)
            [49] +                                                    # artifact (1)
            [50]                                                      # effect (1)
        ),
    },
}
