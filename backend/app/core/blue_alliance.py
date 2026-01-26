import requests
from config import AUTH_HEADER

class BlueAllianceClient:
    def __init__(self):
        self.base_url = 'https://www.thebluealliance.com/api/v3/'

    def fetch_data(self, endpoint):
        headers = {'X-TBA-Auth-Key': AUTH_HEADER}
        response = requests.get(f'{self.base_url}{endpoint}', headers=headers)
        return response.json()  

# Example usage:
# client = BlueAllianceClient()
# data = client.fetch_data('event/2021mike')
# print(data)