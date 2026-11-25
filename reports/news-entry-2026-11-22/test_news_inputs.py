import unittest

import numpy as np

from news_inputs import HOUR, NewsHistory, ms, reduce_events, targets

DATE = "2026-11-01T"


def at(time):
    return DATE + time + ":00Z"


def document(key, collected="01:05", available="01:06", hash_="story"):
    return dict(id=key, storyHash=hash_, publishedAt=at("01:00"),
                collectedAt=at(collected), availableAt=at(available))


def signal(key="event", evidence="doc", **change):
    return dict(dict(eventKey=key, symbols=["BTC"], evidenceIds=[evidence], category="listing",
                     direction="bullish", confidence=.8, materiality=.5, horizon="short_term",
                     claimType="confirmed_announcement", expiresAt=at("04:30"), contradicted=False),
                **change)


class NewsHistoryTests(unittest.TestCase):
    def setUp(self):
        self.data = dict(documents=[document("doc")], analyses=[
            dict(id="analysis", availableAt=at("01:10"), signals=[signal()])
        ], revisions=[])

    def history(self):
        return NewsHistory(self.data, {"BTC", "OP"})

    def test_logged_analysis_and_evidence_times_both_limit_signal(self):
        early = self.history()
        self.assertEqual(early.snapshot("BTC", ms(at("01:08"))), ((1., 0.), [], []))
        self.data["documents"][0]["availableAt"] = at("01:20")
        late = self.history()
        self.assertFalse(late.active("BTC", ms(at("01:10"))))
        self.assertEqual(late.active("BTC", ms(at("01:20")))[0].strength, .4)
        self.assertFalse(late.active("BTC", ms(at("04:30"))))
        self.assertFalse(late.observed(late.document_times, ms(at("02:21")), HOUR))

    def test_copy_does_not_refresh_the_event(self):
        self.data["documents"].append(document("relay", available="01:15"))
        self.data["analyses"].append(dict(id="copy", availableAt=at("01:16"),
                                          signals=[signal("copy", "relay")]))
        event, = self.history().active("BTC", ms(at("01:20")))
        self.assertEqual(event.available, ms(at("01:10")))

    def test_future_revision_leaves_prior_features_identical(self):
        cutoff = ms(at("01:20"))
        old = self.history()
        self.data["revisions"].append(dict(id=1, analysisId="analysis", eventKey="event",
             availableAt=at("01:30"), signal=signal(facts=dict(
                 factKey="fact", change="retraction", targets=[], origins=[]))))
        new = self.history()
        for history in (old, new):
            self.assertEqual(len(history.active("BTC", cutoff)), 1)
        before = [reduce_events(h.active("BTC", cutoff), [], cutoff)[0] for h in (old, new)]
        np.testing.assert_array_equal(*before)
        event, = new.active("BTC", ms(at("01:30")))
        self.assertTrue(event.correction)
        self.assertEqual(event.strength, 0)

    def test_ambiguous_legacy_and_unresolved_structured_target(self):
        self.assertEqual(targets(signal(symbols=["OP", "BTC"]), {"OP", "BTC"}), {"BTC"})
        unresolved = signal(facts={"targets": [{"relation": "unresolved", "symbol": "BTC"}]})
        self.assertEqual(targets(unresolved, {"BTC"}), set())


if __name__ == "__main__":
    unittest.main()
