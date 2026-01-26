class MatchAPI:
    def __init__(self, match_key):
        self.match_key = match_key

    def get_match_data(self):
        """Fetch match data by match key."""
        # Here you will implement the logic to retrieve data from an API
        # This is a placeholder for actual implementation.
        return {
            'match_key': self.match_key,
            'details': 'Fetching match play-by-play details...'
        }

    def get_score_breakdown(self):
        """Fetch score breakdown for the match."""
        # Logic to get score breakdown would go here
        # This is a placeholder for actual implementation.
        return {
            'match_key': self.match_key,
            'score': 'Score breakdown will be here.'
        }