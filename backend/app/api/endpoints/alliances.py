# alliances.py

"""This module handles functionalities for alliance-related data from The Blue Alliance API."""

import requests

class AllianceAPI:
    API_URL = "https://www.thebluealliance.com/api/v3"

    def __init__(self, api_key):
        self.api_key = api_key

    def get_alliances(self, team_key):
        """Fetch alliances for a specific team from The Blue Alliance."""
        response = requests.get(f"{self.API_URL}/team/{team_key}/alliances", headers={"X-TBA-Auth-Key": self.api_key})
        return response.json() if response.status_code == 200 else None

    def get_alliance_data(self, event_key):
        """Fetch alliance data for a specific event."""
        response = requests.get(f"{self.API_URL}/event/{event_key}/alliances", headers={"X-TBA-Auth-Key": self.api_key})
        return response.json() if response.status_code == 200 else None

# Example usage:
# api = AllianceAPI('your_api_key_here')
# alliances = api.get_alliances('frc254')
# print(alliances)